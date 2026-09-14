// GET /o/<token> — personalized offer landing page for SMS subscribers.
//
// The subscriber taps the SMS link (/r/<id> logs the tap, 302s here).
// Renders: their #1 job match + 3 profile-matched offer slots.
// Every offer is labeled "Sponsored". Slots with no cta_url configured
// render a graceful "coming soon" card — the page never breaks on
// missing affiliate links. noindex: this is a personal page.

import { ensureSchema } from "../_shared/db.js";
import { esc, pageChrome, APP_URL } from "../_shared/seo.js";
import { getOfferSlots, pickOfferSlots, mintLink } from "../_shared/sms.js";
import { scoreJob } from "../_shared/fit.js";

function jobCard(job) {
  if (!job) return `<div class="card"><h2 style="margin-top:0">🎯 Your top match</h2><p class="muted">New matches are being scored — check back soon.</p></div>`;
  const salary = job.salary_min || job.salary_max
    ? `<div class="muted">💰 ${job.salary_min ? "$" + Number(job.salary_min).toLocaleString() : ""}${job.salary_max ? "–$" + Number(job.salary_max).toLocaleString() : ""}</div>` : "";
  return `<div class="card" style="border:2px solid #22c55e">
    <div style="font-size:13px;font-weight:700;color:#16a34a">🎯 YOUR #1 MATCH · FREE</div>
    <h2 style="margin:8px 0">${esc(job.title)}</h2>
    <div class="muted">${esc(job.company_name || "")}${job.location ? " · " + esc(job.location) : ""}${job.remote_policy && job.remote_policy !== "unknown" ? " · " + esc(job.remote_policy) : ""}</div>
    ${salary}
    ${job.fit_score != null ? `<div style="margin-top:6px">Fit score: <b>${job.fit_score}</b>/100</div>` : ""}
    <div style="margin-top:12px"><a class="btn" href="${esc(job.url)}" target="_blank" rel="noopener">View & apply →</a></div>
  </div>`;
}

function offerCard(slot, ctaHref) {
  const coming = !slot.cta_url;
  const cta = coming
    ? `<div class="btn" style="opacity:.45;pointer-events:none">${esc(slot.cta_text)} — coming soon</div>`
    : `<a class="btn" href="${esc(ctaHref)}" target="_blank" rel="noopener">${esc(slot.cta_text)} →</a>`;
  return `<div class="card">
    <div style="font-size:11px;font-weight:700;color:#a16207;letter-spacing:.06em">SPONSORED</div>
    ${slot.image_url ? `<img src="${esc(slot.image_url)}" alt="" style="width:100%;border-radius:8px;margin:8px 0" loading="lazy">` : ""}
    <h3 style="margin:8px 0">${esc(slot.headline)}</h3>
    ${slot.body ? `<p class="muted">${esc(slot.body)}</p>` : ""}
    <div style="margin-top:10px">${cta}</div>
  </div>`;
}

async function bestMatch(db, contact) {
  const base = await db.prepare(`
    SELECT j.id, j.title, j.url, j.location, j.remote_policy, j.employment_type,
           j.salary_min, j.salary_max, j.description_text, c.name AS company_name
    FROM job j JOIN company c ON c.id = j.company_id
    WHERE j.is_active = 1
    ORDER BY j.last_seen_at DESC LIMIT 300
  `).all().catch(() => ({ results: [] }));
  const jobs = base.results || [];
  if (!jobs.length) return { job: null, profile: {} };

  let profile = null, resumeScore = 100, skillGaps = [];
  if (contact?.user_id) {
    const up = await db.prepare("SELECT * FROM user_profile WHERE user_id = ?").bind(contact.user_id).first().catch(() => null);
    const ur = await db.prepare("SELECT llm_review_json FROM user_resume WHERE user_id = ?").bind(contact.user_id).first().catch(() => null);
    if (up) {
      const j = (s, fb) => { try { return JSON.parse(s || "null") ?? fb; } catch { return fb; } };
      profile = {
        target_titles: j(up.target_titles_json, []),
        keywords: j(up.keywords_json, []),
        locations: j(up.locations_json, []),
        remote_required: !!up.remote_required,
        min_salary_usd: up.min_salary_usd || null,
        preferred_industries: j(up.preferred_industries_json, []),
        notes: "",
      };
    }
    if (ur?.llm_review_json) {
      try {
        const rev = JSON.parse(ur.llm_review_json);
        if (Number.isFinite(Number(rev.score))) resumeScore = Number(rev.score);
        if (Array.isArray(rev.gaps)) skillGaps = rev.gaps.slice(0, 5);
      } catch { /* ignore */ }
    }
  }

  let best = jobs[0], bestScore = -1;
  if (profile) {
    for (const job of jobs) {
      try {
        const s = scoreJob(job, profile, null);
        const sc = Number(s?.score ?? s ?? 0);
        if (sc > bestScore) { bestScore = sc; best = job; }
      } catch { /* ignore */ }
    }
    best.fit_score = Math.max(0, Math.round(bestScore));
  }
  return {
    job: best,
    profile: { resume_score: resumeScore, skill_gaps: skillGaps, remote_ok: !!(profile?.remote_required) },
  };
}

export async function onRequestGet({ env, params, request }) {
  const token = String(params?.token || "").slice(0, 64);
  await ensureSchema(env).catch(() => null);
  const db = env?.JOBS_DB;

  const link = token && db
    ? await db.prepare("SELECT public_id, contact_id, offer_slot FROM sms_link WHERE public_id = ? AND kind = 'offer_page'")
      .bind(token).first().catch(() => null)
    : null;

  if (!link) {
    const html = pageChrome({
      title: "Link not found — mehyar.jobs", noindex: true,
      body: `<h1>Link not found</h1><p class="muted">That link is gone. <a href="${APP_URL}/">Get free job alerts →</a></p>`,
    });
    return new Response(html, { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  const contact = link.contact_id
    ? await db.prepare("SELECT id, user_id FROM sms_contact WHERE id = ?").bind(link.contact_id).first().catch(() => null)
    : null;

  const { job, profile } = await bestMatch(db, contact);
  const slots = await getOfferSlots(db);
  const picks = pickOfferSlots(slots, profile);

  // Mint tap-tracked redirect links for each configured offer CTA.
  const cards = [];
  for (const s of picks) {
    let href = null;
    if (s.cta_url) {
      const rid = await mintLink(db, { contactId: contact?.id || null, kind: "redirect", targetUrl: s.cta_url, offerSlot: s.key });
      href = `${APP_URL}/r/${rid}`;
    }
    cards.push(offerCard(s, href));
  }

  const body = `
<div class="card" style="text-align:center">
  <div style="font-size:14px" class="muted">📱 mehyar.jobs · picked for you</div>
  <h1 style="margin:8px 0">Your matches, plus a boost</h1>
  <p class="muted">Free job alerts, fit-scored to you. The offers below are sponsors — they keep the alerts free.</p>
</div>
${jobCard(job)}
<div class="card" style="text-align:center;background:#f0fdf4">
  <h2 style="margin-top:0">💼 Want recruiters to find you?</h2>
  <p class="muted">Opt in once and vetted recruiters can reach out about roles that fit your profile.</p>
  <a class="btn" href="${APP_URL}/recruiter-match${contact ? `?c=${contact.id}` : ""}">Get matched with recruiters →</a>
</div>
<h2>🚀 Career boosts <span style="font-size:12px" class="muted">(sponsored)</span></h2>
${cards.join("\n")}
<div class="card">
  <h2 style="margin-top:0">📧 Get these by email too</h2>
  <p class="muted">One email a day with your new matches. Confirm via the link we send — unsubscribe anytime.</p>
  <form id="offerEmail" style="display:flex;gap:8px;flex-wrap:wrap">
    <input name="email" type="email" required placeholder="you@email.com" style="flex:1;min-width:200px;padding:10px;border:1px solid #ddd;border-radius:8px">
    <button class="btn" type="submit">Send me the email →</button>
  </form>
  <p id="offerEmailMsg" class="muted" style="min-height:1.2em"></p>
</div>
<script>
document.getElementById("offerEmail").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = e.target.email.value;
  const msg = document.getElementById("offerEmailMsg");
  msg.textContent = "Sending confirmation…";
  try {
    const r = await fetch("/api/public/offer-email", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, source: "offer_page" }) });
    const d = await r.json();
    msg.textContent = d.ok ? "Check your inbox to confirm — then you're in." : ("Hmm: " + (d.error || "try again"));
  } catch { msg.textContent = "Network hiccup — try again."; }
});
</script>`;

  const html = pageChrome({
    title: "Your top job match + career boosts — mehyar.jobs",
    description: "Your #1 fit-scored job match, plus sponsored career boosts picked for your profile. Free forever.",
    noindex: true,
    body,
  });
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
