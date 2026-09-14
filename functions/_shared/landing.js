// _shared/landing.js
//
// Landing rotation for the Genius Flow email engine (Worker 6):
//   * signed preference pages   (/pref/<pref-token>)
//   * dated campaign slugs      (/go/<date>-<token>)
//   * per-product gear pages     (/gear/<product-slug>)
//   * per-slug click/open attribution feeding the dashboard landing-stats
//     admin API.
//
// HARD RULES:
//   - Emails never link to Amazon directly. The affiliate click happens on
//     our /gear/<slug> page (via a tap-tracked /r/<id> redirect), and the
//     #ad disclosure lives in the email AND on the page.
//   - Yotru / JobTestPrep (approved=0) get a page that says "not available
//     yet" and NEVER an affiliate link.
//   - Old /go/<offer-slug> links keep working: dated slugs are matched by
//     a date-prefixed pattern before the legacy offer-slot path runs.
//   - Preference consent is explicit-only: unchecked default checkbox; a
//     consent row is written only when the box is checked.

import { hashStr } from "./emailFunnel.js";

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Dated campaign slug: /go/2026-09-15-k7x2qm9a
export const DATED_SLUG_RE = /^(\d{4}-\d{2}-\d{2})-([a-z0-9]{6,16})$/;

// ── preference form options (fixed vocab — form values are validated) ──
export const PREFERENCE_OPTIONS = {
  industries: [
    "technology", "finance", "healthcare", "education", "retail",
    "hospitality", "manufacturing", "media_marketing", "government",
    "nonprofit", "construction", "transportation", "other",
  ],
  industryLabels: {
    technology: "Technology", finance: "Finance", healthcare: "Healthcare",
    education: "Education", retail: "Retail", hospitality: "Hospitality",
    manufacturing: "Manufacturing", media_marketing: "Media & Marketing",
    government: "Government", nonprofit: "Nonprofit", construction: "Construction",
    transportation: "Transportation", other: "Other",
  },
  workStyles: ["remote", "hybrid", "on_site"],
  workStyleLabels: { remote: "Remote", hybrid: "Hybrid", on_site: "On-site" },
  wants: ["job_alerts", "resume_review"],
  wantLabels: { job_alerts: "Free job-match alerts", resume_review: "Free resume review" },
};

// Exact consent language stored with every YES. Keep this sentence in sync
// with the checkbox label on the preference page.
export function consentLanguage(email) {
  const em = String(email || "").trim().toLowerCase();
  return `Yes, send me free job-match emails from mehyar.jobs at ${em}. I can unsubscribe anytime with one click.`;
}

// Canonical gear-page URL for a catalog product. Campaign emails link here,
// NEVER to the raw Amazon dp URL.
export function gearUrlFor(appUrl, slug) {
  return `${String(appUrl || "https://jobs.mehyar.us").replace(/\/+$/, "")}/gear/${String(slug || "")}`;
}

// ── dated campaign slugs ─────────────────────────────────────────────
// Idempotent: one row per date. ctx = { template, product_slug, product_angle }.
function mintDayToken() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n.toString(36).padStart(8, "0").slice(0, 8);
}

export async function getOrCreateDaySlug(db, dateStr, ctx = {}) {
  if (!DATE_RE.test(dateStr)) throw new Error("bad_date");
  const existing = await db.prepare("SELECT * FROM landing_slug WHERE date = ?").bind(dateStr).first();
  if (existing) return existing;
  const token = mintDayToken();
  const slug = `${dateStr}-${token}`;
  try {
    await db.prepare(
      `INSERT INTO landing_slug (slug, date, token, page_type, template, product_slug, product_angle)
       VALUES (?, ?, ?, 'go', ?, ?, ?)`
    ).bind(slug, dateStr, token, ctx.template || null, ctx.product_slug || null, ctx.product_angle || null).run();
  } catch { /* race: another writer won */ }
  return db.prepare("SELECT * FROM landing_slug WHERE date = ?").bind(dateStr).first();
}

export async function getDaySlug(db, slug) {
  const m = DATED_SLUG_RE.exec(String(slug || ""));
  if (!m) return null;
  return db.prepare("SELECT * FROM landing_slug WHERE slug = ?").bind(slug).first();
}

// ── attribution ──────────────────────────────────────────────────────
// Logs a landing-page hit, bumps the go-slug counters (with a
// first-seen-visitor check for unique_clicks), and — when the visitor is
// an identified contact — writes an email_event click carrying the slug
// in meta_json so the campaign report can attribute it.
export function visitorKeyFor(contactId, ip) {
  if (contactId) return `c${contactId}`;
  return `h${(hashStr(String(ip || "unknown")) >>> 0).toString(36)}`;
}

export async function recordLandingClick(db, { date, pageType, slug, productSlug = null, contactId = null, ip = null, kind = "click" }) {
  if (!DATE_RE.test(date)) throw new Error("bad_date");
  const visitorKey = visitorKeyFor(contactId, ip);
  await db.prepare(
    `INSERT INTO landing_hit (date, page_type, slug, product_slug, contact_id, visitor_key, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(date, pageType, slug, productSlug, contactId || null, visitorKey, kind).run();

  if (pageType === "go") {
    // A visitor is "new" for this slug when this hit is their first one.
    const earlier = await db.prepare(
      "SELECT COUNT(*) AS n FROM landing_hit WHERE page_type = 'go' AND slug = ? AND visitor_key = ?"
    ).bind(slug, visitorKey).first();
    const isNew = Number(earlier?.n || 0) <= 1;
    await db.prepare(
      `UPDATE landing_slug SET clicks = clicks + 1, unique_clicks = unique_clicks + ?
       WHERE slug = ?`
    ).bind(isNew ? 1 : 0, slug).run();
  }

  if (contactId) {
    try {
      const meta = { landing_slug: slug, landing_page: pageType };
      if (productSlug) meta.product_slug = productSlug;
      await db.prepare(
        "INSERT INTO email_event (contact_id, kind, mpp_suspect, meta_json) VALUES (?, 'click', 0, ?)"
      ).bind(contactId, JSON.stringify(meta)).run();
      await db.prepare(
        "UPDATE contact_engagement SET clicks = clicks + 1, last_click_at = datetime('now'), sends_since_engagement = 0, updated_at = datetime('now') WHERE contact_id = ?"
      ).bind(contactId).run().catch(() => null);
    } catch { /* attribution must never break the page render */ }
  }
  return { visitorKey };
}

// ── landing-stats aggregation (dashboard) ────────────────────────────
export async function landingStatsForDate(db, dateStr) {
  if (!DATE_RE.test(dateStr)) throw new Error("bad_date");
  const hits = await db.prepare(
    `SELECT page_type, slug, product_slug, MIN(created_at) AS first_seen,
            COUNT(*) AS clicks, COUNT(DISTINCT visitor_key) AS unique_clicks
     FROM landing_hit WHERE date = ? GROUP BY page_type, slug, product_slug`
  ).bind(dateStr).all();
  const goRows = await db.prepare("SELECT slug, created_at FROM landing_slug WHERE date = ?").bind(dateStr).all();
  const goCreated = new Map((goRows.results || []).map((r) => [r.slug, r.created_at]));
  return (hits.results || []).map((h) => ({
    slug: h.slug,
    page_type: h.page_type,
    product_slug: h.product_slug || null,
    clicks: Number(h.clicks || 0),
    unique_clicks: Number(h.unique_clicks || 0),
    created_at: h.page_type === "go" && goCreated.get(h.slug) ? goCreated.get(h.slug) : h.first_seen,
  })).sort((a, b) => b.clicks - a.clicks || String(a.slug).localeCompare(String(b.slug)));
}

// ── contacts: find-or-create, preferences, graduation ────────────────
export async function ensureEmailContact(db, email) {
  const em = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)) throw new Error("bad_email");
  await db.prepare(
    "INSERT OR IGNORE INTO email_contact (email, status, source) VALUES (?, 'pending', 'web')"
  ).bind(em).run();
  return db.prepare("SELECT * FROM email_contact WHERE email = ?").bind(em).first();
}

export async function getContactPreference(db, contactId) {
  const r = await db.prepare("SELECT * FROM contact_preference WHERE contact_id = ?").bind(contactId).first();
  if (!r) return { industries: [], work_style: null, wants: [] };
  let industries = [], wants = [];
  try { industries = JSON.parse(r.industries_json || "[]"); } catch { industries = []; }
  try { wants = JSON.parse(r.wants_json || "[]"); } catch { wants = []; }
  return { industries: Array.isArray(industries) ? industries : [], work_style: r.work_style || null, wants: Array.isArray(wants) ? wants : [] };
}

export function parsePreferenceForm(form) {
  const getAll = (k) => {
    const v = typeof form.getAll === "function" ? form.getAll(k) : (form.get(k) != null ? [form.get(k)] : []);
    return v.map((x) => String(x || "").trim()).filter(Boolean);
  };
  const industries = getAll("industries").filter((i) => PREFERENCE_OPTIONS.industries.includes(i));
  const ws = String(form.get("work_style") || "").trim();
  const workStyle = PREFERENCE_OPTIONS.workStyles.includes(ws) ? ws : null;
  const wants = getAll("wants").filter((w) => PREFERENCE_OPTIONS.wants.includes(w));
  const consent = String(form.get("email_consent") || "").toLowerCase();
  const consentGiven = consent === "yes" || consent === "on" || consent === "1" || consent === "true";
  return { industries, workStyle, wants, consentGiven };
}

export async function savePreferences(db, contactId, { industries, workStyle, wants }) {
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO contact_preference (contact_id, industries_json, work_style, wants_json, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(contact_id) DO UPDATE SET
       industries_json = excluded.industries_json,
       work_style = excluded.work_style,
       wants_json = excluded.wants_json,
       updated_at = excluded.updated_at`
  ).bind(contactId, JSON.stringify(industries || []), workStyle || null, JSON.stringify(wants || []), now).run();
}

// Graduation: an engaged human told us what they want -> off the legacy
// stream (SMTP2GO aged cohort) onto the fresh stream (Brevo), status
// active. Consent is recorded ONLY when the explicit checkbox was checked;
// the checkbox language is stored verbatim and mirrored in
// consent_log_json like the 0016 pattern.
export async function graduateContact(db, contact, { consentGiven = false } = {}) {
  const now = new Date().toISOString();
  const language = consentLanguage(contact.email);
  const entry = { ts: now, language, source: "preference_page", consent: consentGiven ? "yes" : "no" };
  let log = [];
  try { log = JSON.parse(contact.consent_log_json || "[]"); } catch { log = []; }
  if (!Array.isArray(log)) log = [];
  log.push(entry);
  await db.prepare(
    "UPDATE email_contact SET status = 'active', source = 'web', consent_log_json = ? WHERE id = ?"
  ).bind(JSON.stringify(log), contact.id).run();
  if (consentGiven) {
    await db.prepare(
      `INSERT INTO email_consent (contact_id, email, kind, consent_text, consent_ts, source_cohort)
       VALUES (?, ?, 'preference_page_yes', ?, ?, 'web')`
    ).bind(contact.id, contact.email, language, now).run();
  }
  return db.prepare("SELECT * FROM email_contact WHERE id = ?").bind(contact.id).first();
}

// ── page builders (site chrome is applied by the route via pageChrome) ──

function checkboxRow({ name, value, label, checked }) {
  return `<label style="display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid #26262f;border-radius:10px;margin:8px 0;cursor:pointer">
    <input type="checkbox" name="${esc(name)}" value="${esc(value)}"${checked ? " checked" : ""} style="margin-top:4px;accent-color:#7c3aed">
    <span>${esc(label)}</span></label>`;
}

export function buildPreferencePage({ token, email, saved, appUrl, savedMsg = false }) {
  const s = saved || { industries: [], work_style: null, wants: [] };
  const ind = PREFERENCE_OPTIONS.industries
    .map((k) => checkboxRow({ name: "industries", value: k, label: PREFERENCE_OPTIONS.industryLabels[k], checked: s.industries.includes(k) }))
    .join("");
  const ws = PREFERENCE_OPTIONS.workStyles
    .map((k) => `<label style="display:flex;gap:10px;align-items:center;padding:10px 12px;border:1px solid #26262f;border-radius:10px;margin:8px 0;cursor:pointer">
      <input type="radio" name="work_style" value="${k}"${s.work_style === k ? " checked" : ""} style="accent-color:#7c3aed">
      <span>${esc(PREFERENCE_OPTIONS.workStyleLabels[k])}</span></label>`)
    .join("");
  const wn = PREFERENCE_OPTIONS.wants
    .map((k) => checkboxRow({ name: "wants", value: k, label: PREFERENCE_OPTIONS.wantLabels[k], checked: s.wants.includes(k) }))
    .join("");
  return `
  <div class="card">
    ${savedMsg ? `<p class="pill">Saved. Your matches will use these from now on.</p>` : ""}
    <h1>Your job-search preferences</h1>
    <p class="muted">Tell me what you're looking for and I'll tune your free matches to it. ${esc(email)}</p>
    <form method="POST" action="/pref/${esc(token)}">
      <h2>Industries you're targeting</h2>
      ${ind}
      <h2>Work style</h2>
      ${ws}
      <h2>What do you want from mehyar.jobs?</h2>
      ${wn}
      <h2>Email consent</h2>
      <label style="display:flex;gap:10px;align-items:flex-start;padding:12px;border:1px solid #7c3aed;border-radius:10px;margin:8px 0;cursor:pointer;background:#1a1430">
        <input type="checkbox" name="email_consent" value="yes" style="margin-top:4px;accent-color:#7c3aed">
        <span><strong>${esc(consentLanguage(email))}</strong><br>
        <span class="muted">Unchecked means no change. You can withdraw consent anytime with the one-click unsubscribe in any email.</span></span>
      </label>
      <button type="submit" class="btn" style="border:0;cursor:pointer;font-size:16px">Save preferences</button>
    </form>
  </div>
  <p class="muted">mehyar.jobs · free job search, free forever. <a href="${esc(appUrl)}/unsubscribe">Unsubscribe</a> anytime.</p>`;
}

export function buildCampaignLandingView({ slugRow, product, appUrl, prefToken = null }) {
  const productBlock = product
    ? `<div class="card">
        <span class="pill">Today's featured pick</span>
        <h2 style="margin-top:8px">${esc(product.name)}</h2>
        ${product.description ? `<p class="muted">${esc(product.description)}</p>` : ""}
        ${slugRow.product_angle ? `<p><strong>${esc(slugRow.product_angle)}.</strong></p>` : ""}
        <a class="btn" href="${esc(gearUrlFor(appUrl, product.slug))}">See the full review</a>
        <p class="muted" style="margin-top:10px">#ad: affiliate link — we may earn a commission if you buy through it.</p>
      </div>`
    : `<div class="card"><p class="muted">No featured pick for this day.</p></div>`;
  const prefCta = prefToken
    ? `<div class="card"><h2>Make your matches sharper</h2>
       <p class="muted">Thirty seconds: pick your industries, work style, and what you want from mehyar.jobs.</p>
       <a class="btn" href="${esc(appUrl)}/pref/${esc(prefToken)}">Set my preferences</a></div>`
    : `<div class="card"><h2>Make your matches sharper</h2>
       <p class="muted">Your personalized preference link is in today's email — thirty seconds, no login.</p></div>`;
  return `
  <div class="card">
    <span class="pill">Daily picks · ${esc(slugRow.date)}</span>
    <h1>Today's job-market picks</h1>
    ${slugRow.template ? `<p class="muted">Today's focus: ${esc(slugRow.template)}</p>` : ""}
  </div>
  ${productBlock}
  ${prefCta}
  <p class="muted">mehyar.jobs · free job search, free forever.</p>`;
}

export function buildGearPage({ product, eligible, ctaUrl }) {
  const image = product.image_url
    ? `<img src="${esc(product.image_url)}" alt="${esc(product.name)}" style="max-width:100%;border-radius:12px">`
    : `<div style="border:2px dashed #3a3a45;border-radius:12px;padding:48px 16px;text-align:center;color:#9a9aa5;font-size:13px">Product image coming soon</div>`;
  const body = eligible
    ? `<div class="card">
         <span class="sponsored">#ad · Affiliate pick</span>
         <h1 style="margin-top:10px">${esc(product.name)}</h1>
         ${image}
         ${product.description ? `<p style="margin-top:16px">${esc(product.description)}</p>` : ""}
         <a class="btn" href="${esc(ctaUrl)}" rel="nofollow sponsored noopener" style="font-size:18px;padding:14px 28px">Check the price</a>
         <p class="muted" style="margin-top:16px">#ad disclosure: this page contains an affiliate link. If you buy through it, we may earn a commission — it keeps mehyar.jobs free for job seekers. Our pick, our honest take.</p>
       </div>`
    : `<div class="card">
         <h1>${esc(product.name)}</h1>
         ${product.description ? `<p class="muted">${esc(product.description)}</p>` : ""}
         <p><strong>This pick is not available yet.</strong> We're still setting it up — check back soon.</p>
       </div>`;
  return `${body}<p class="muted">mehyar.jobs · free job search, free forever.</p>`;
}

export function notFoundPage(title = "Not found") {
  return `<div class="card"><h1>${esc(title)}</h1><p class="muted"><a href="/">Back to mehyar.jobs</a></p></div>`;
}
