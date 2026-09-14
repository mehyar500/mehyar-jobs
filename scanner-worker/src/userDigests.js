// scanner-worker/src/userDigests.js
//
// Per-user digest fan-out. After the owner's daily digest goes out, every
// newsletter subscriber with an active resume gets their own email with the
// day's new jobs scored against THEIR profile (not the owner's).
//
// Runs inside the scheduled worker (has D1 + send_email). Bounded: at most
// USERS_PER_RUN users per cron invocation; user_digest_log makes retries
// idempotent.

import { getUserFitProfile, signUnsubscribeToken } from "../../functions/_shared/userAuth.js";
import { scoreJob } from "../../functions/_shared/fit.js";
import { getActiveSponsor, sponsorEmailHtml, sponsorEmailText } from "../../functions/_shared/sponsors.js";
import { getOfferSlots, getFeaturedOfferSlot, offerEmailHtml, offerEmailText } from "../../functions/_shared/sms.js";

const USERS_PER_RUN = 40;
const MATCHES_PER_EMAIL = 20;
// Calibration: a strong title+keyword match scores ~50 on a short resume,
// so 45 sends genuinely relevant jobs while still filtering noise (<35).
const MIN_SCORE = 45;

function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function buildUserDigestEmail(user, matches, scanDay, appUrl, env) {
  let sponsor = null;
  try { sponsor = await getActiveSponsor(env?.JOBS_DB, "email"); } catch { /* sponsor is optional */ }
  let offer = null;
  try { offer = getFeaturedOfferSlot(await getOfferSlots(env?.JOBS_DB)); } catch { /* offer is optional */ }
  const name = user.display_name || "there";
  const strong = matches.filter((m) => m.score >= 70 && !m.hard_no);
  const subject = `mehyar.jobs: ${matches.length} new matches for you — ${strong.length} strong`;
  let unsubUrl = `${appUrl}/unsubscribe`;
  try {
    const token = await signUnsubscribeToken(user.email, env);
    unsubUrl = `${appUrl}/unsubscribe?token=${encodeURIComponent(token)}`;
  } catch { /* one-click link is best-effort; page still works */ }
  const rows = matches.map((m, i) => {
    const salary = m.salary_min || m.salary_max
      ? ` · $${Number(m.salary_min || 0).toLocaleString()}${m.salary_max ? `–$${Number(m.salary_max).toLocaleString()}` : ""}`
      : "";
    return `${i + 1}. ${m.title} — ${m.company_name} (${m.score}/100)${salary}\n   ${m.location || ""} ${m.remote_policy === "remote" ? "[remote]" : ""}\n   ${m.url}`;
  });
  const text = [
    `Hi ${name},`,
    ``,
    `Your daily mehyar.jobs digest for ${scanDay}:`,
    ``,
    `New matches: ${matches.length} (${strong.length} strong at 70+)`,
    ``,
    ...rows,
    ``,
    `See them all and re-run your resume any time: ${appUrl}/matches`,
    `Unsubscribe instantly (one click, no login): ${unsubUrl}`,
    ...sponsorEmailText(sponsor),
    ...offerEmailText(offer, appUrl),
    `— mehyar.jobs`,
  ].join("\n");

  const htmlRows = matches.map((m) => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #eee">
        <a href="${esc(m.url)}" style="font-weight:600;color:#1a56db">${esc(m.title)}</a>
        <span style="color:#666"> — ${esc(m.company_name)}</span>
        <span style="display:inline-block;background:#eef2ff;color:#3730a3;border-radius:999px;padding:1px 8px;font-size:12px;margin-left:6px">${m.score}/100</span>
        <div style="color:#666;font-size:13px">${esc(m.location || "")}${m.remote_policy === "remote" ? " · remote" : ""}</div>
      </td>
    </tr>`).join("");

  const html = `
    <p>Hi ${esc(name)},</p>
    <p>Your daily <strong>mehyar.jobs</strong> digest for ${esc(scanDay)}: <strong>${matches.length}</strong> new matches (${strong.length} strong at 70+).</p>
    <table style="width:100%;border-collapse:collapse">${htmlRows}</table>
    <p><a href="${esc(appUrl)}/matches">See all your matches</a> · re-run your resume any time.</p>
    ${sponsorEmailHtml(sponsor)}
    ${offerEmailHtml(offer, appUrl)}
    <p style="color:#888;font-size:12px"><a href="${esc(unsubUrl)}" style="color:#888">Unsubscribe instantly</a> · — mehyar.jobs</p>`;
  return { subject, text, html };
}

async function loadNewJobsForDigest(db, scanDay) {
  // Jobs first seen today (UTC) — the same "what's new" set the owner digest uses.
  const rows = await db.prepare(`
    SELECT j.id, j.title, j.url, j.location, j.remote_policy, j.employment_type,
           j.salary_min, j.salary_max, j.salary_currency, j.posted_at,
           j.description_text, c.name AS company_name, c.industry AS company_industry
    FROM job j JOIN company c ON c.id = j.company_id
    WHERE j.is_active = 1
      AND j.first_seen_at >= ?
      AND j.first_seen_at < datetime(?, '+1 day')
    ORDER BY j.id ASC
    LIMIT 1000
  `).bind(scanDay, scanDay).all().catch(() => ({ results: [] }));
  return rows.results || [];
}

export async function deliverUserDigests(env, scanDay) {
  const db = env.JOBS_DB;
  if (!db) return { ok: false, error: "no_db" };
  if (!env.EMAIL || typeof env.EMAIL.send !== "function") {
    return { ok: false, error: "EMAIL binding missing" };
  }
  const appUrl = env.JOBS_APP_URL || "https://jobs.mehyar.us";
  const sender = env.DIGEST_FROM_EMAIL || "noreply@mehyar.us";

  // Newsletter subscribers with a resume, not yet emailed for this scan day.
  // The owner (is_admin) is excluded — he gets the admin digest.
  const users = await db.prepare(`
    SELECT u.id, u.email, u.display_name
    FROM app_user u
    WHERE u.newsletter_opt_in = 1
      AND u.is_admin = 0
      AND EXISTS (SELECT 1 FROM user_resume r WHERE r.user_id = u.id AND r.is_active = 1)
      AND NOT EXISTS (SELECT 1 FROM user_digest_log l WHERE l.user_id = u.id AND l.scan_day = ?)
    ORDER BY u.id ASC
    LIMIT ?
  `).bind(scanDay, USERS_PER_RUN).all().catch(() => ({ results: [] }));
  const list = users.results || [];
  if (!list.length) return { ok: true, sent: 0 };

  const newJobs = await loadNewJobsForDigest(db, scanDay);
  const outcome = { ok: true, sent: 0, skipped_no_matches: 0, errors: [] };

  for (const user of list) {
    try {
      const profile = await getUserFitProfile(env, user.id);
      if (!profile || !profile.keywords.length) {
        await db.prepare("INSERT OR IGNORE INTO user_digest_log (user_id, scan_day, match_count, strong_match_count) VALUES (?, ?, 0, 0)")
          .bind(user.id, scanDay).run().catch(() => null);
        outcome.skipped_no_matches += 1;
        continue;
      }
      const matches = [];
      for (const job of newJobs) {
        const s = scoreJob(
          {
            title: job.title, description_text: job.description_text, location: job.location,
            remote_policy: job.remote_policy, salary_min: job.salary_min,
            salary_max: job.salary_max, posted_at: job.posted_at,
          },
          profile, job.company_industry
        );
        if (s.score >= MIN_SCORE && !s.hard_no) matches.push({ ...job, score: s.score });
      }
      matches.sort((a, b) => b.score - a.score);
      const top = matches.slice(0, MATCHES_PER_EMAIL);
      const strong = matches.filter((m) => m.score >= 70).length;

      // Log the outcome only after the delivery result is known: a failed
      // send must NOT mark the user done, or the retry would skip them.
      if (!top.length) {
        await db.prepare("INSERT OR IGNORE INTO user_digest_log (user_id, scan_day, match_count, strong_match_count) VALUES (?, ?, ?, ?)")
          .bind(user.id, scanDay, matches.length, strong).run().catch(() => null);
        outcome.skipped_no_matches += 1;
        continue;
      }

      const email = await buildUserDigestEmail(user, top, scanDay, appUrl, env);
      await env.EMAIL.send({
        to: user.email,
        from: { email: sender, name: "mehyar.jobs" },
        replyTo: env.DIGEST_REPLY_TO || "info@mehyar.us",
        subject: email.subject,
        text: email.text,
        html: email.html,
        headers: { "X-Campaign-ID": `daily-jobs-user-${scanDay}` },
      });
      await db.prepare("INSERT OR IGNORE INTO user_digest_log (user_id, scan_day, match_count, strong_match_count) VALUES (?, ?, ?, ?)")
        .bind(user.id, scanDay, matches.length, strong).run().catch(() => null);
      outcome.sent += 1;
    } catch (e) {
      outcome.errors.push({ user: user.id, error: String(e?.message || e).slice(0, 200) });
    }
  }
  console.log(JSON.stringify({ event: "user_digests_delivered", scan_day: scanDay, ...outcome, errors: outcome.errors.length }));
  return outcome;
}
