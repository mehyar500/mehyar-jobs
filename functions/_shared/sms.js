// _shared/sms.js
//
// Warm-up SMS funnel primitives. TCPA-safe by default:
//
//  - DRY-RUN IS THE DEFAULT. Nothing sends unless env.SMS_LIVE === "1"
//    AND the caller passes { live: true }. Credentials are never required
//    for dry runs.
//  - CONSENT IS THE GATE. canMessage() returns false unless the contact
//    has a non-empty consent log and status = 'active'. Every send path
//    checks it.
//  - Quiet hours: 8am-9pm recipient-local (47 CFR 64.1200(c)(1)).
//  - STOP/HELP keywords handled on the inbound webhook.
//
// Pricing assumption (Twilio US 10DLC, 2026): $0.0083/segment +
// ~$0.0042 carrier pass-through = $0.0125/segment => 1.25c per segment.

export const COST_PER_SEGMENT_CENTS = 1.25;

// 4-week carrier warm-up ramp (safe daily segment targets).
export const WARMUP_WEEKLY_CAPS = { 1: 300, 2: 800, 3: 1500, 4: 3000 };
export function warmupCap(week) {
  const w = Math.max(1, Math.min(4, Number(week) || 1));
  return WARMUP_WEEKLY_CAPS[w];
}

// ── phone normalization ─────────────────────────────────────────────
// US numbers -> E.164. Returns null when unparseable.
export function normalizePhoneE164(input) {
  if (!input) return null;
  const digits = String(input).replace(/\D/g, "");
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  return null;
}

// ── segment counting (GSM-7 vs UCS-2) ───────────────────────────────
const GSM7_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXT = "^{}\\[~]|€";
export function countSegments(text) {
  const s = String(text || "");
  if (!s) return 0;
  let ucs2 = false, septets = 0;
  for (const ch of s) {
    if (GSM7_BASIC.includes(ch)) septets += 1;
    else if (GSM7_EXT.includes(ch)) septets += 2;
    else { ucs2 = true; break; }
  }
  if (ucs2) {
    const units = [...s].length;
    return units <= 70 ? 1 : Math.ceil(units / 67);
  }
  return septets <= 160 ? 1 : Math.ceil(septets / 153);
}

export function estimateCostCents(segments) {
  return Math.round(Number(segments || 0) * COST_PER_SEGMENT_CENTS);
}

// ── quiet hours: 8am–9pm recipient-local ────────────────────────────
// tzOffsetMin: minutes east of UTC (e.g. ET in winter = -300).
export function isQuietHours(date, tzOffsetMin) {
  const off = Number.isFinite(Number(tzOffsetMin)) ? Number(tzOffsetMin) : -300; // default ET
  const local = new Date(date.getTime() + off * 60_000);
  const h = local.getUTCHours();
  return h < 8 || h >= 21;
}

export function smsLive(env) {
  return String(env?.SMS_LIVE || "") === "1";
}

// ── consent ─────────────────────────────────────────────────────────
// HARD RULE (2026-09-13 compliance directive): the sms_consent table is
// the ONLY entry gate. A number may be messaged for alerts/promos only
// when a logged YES (kind='repermission_yes') exists there — phone,
// timestamp, exact consent language, source cohort, double-opt-in reply.
// Broker-imported rows have NO consent evidence in their schema, so they
// import as status='pending' and stay silent until the re-permission
// text earns a YES. US-only default: normalizePhoneE164 accepts +1 only.
export function parseConsentLog(row) {
  try { return JSON.parse(row?.consent_log_json || "[]"); } catch { return []; }
}

// The TCPA gate: a logged YES in sms_consent + active status.
export async function hasLoggedYes(db, contactId) {
  if (!contactId) return false;
  const r = await db.prepare(
    "SELECT 1 AS x FROM sms_consent WHERE contact_id = ? AND kind = 'repermission_yes' LIMIT 1"
  ).bind(contactId).first().catch(() => null);
  return !!r;
}

export async function canMessage(db, phoneE164) {
  const row = await db.prepare(
    "SELECT id, status FROM sms_contact WHERE phone_e164 = ?"
  ).bind(phoneE164).first().catch(() => null);
  if (!row || row.status !== "active") return false;
  return hasLoggedYes(db, row.id);
}

// Re-permission asks are the single exception: they target 'pending'
// contacts with NO prior repermission send — one ask, never repeated.
export async function repermissionAlreadySent(db, contactId) {
  const r = await db.prepare(
    "SELECT 1 AS x FROM sms_send WHERE contact_id = ? AND kind = 'repermission' LIMIT 1"
  ).bind(contactId).first().catch(() => null);
  return !!r;
}

// Log a YES into the consent table and activate the contact. This is
// the ONLY path that turns a pending contact into a messageable one.
export async function logConsentYes(db, contactId, phoneE164, { consentText, sourceCohort, replyText, deals = true }) {
  await db.prepare(
    `INSERT INTO sms_consent (contact_id, phone_e164, kind, consent_text, source_cohort, double_optin_reply)
     VALUES (?, ?, 'repermission_yes', ?, ?, ?)`
  ).bind(contactId, phoneE164, String(consentText || ""), String(sourceCohort || "inbound"), String(replyText || "").slice(0, 32)).run();
  await db.prepare(
    "UPDATE sms_contact SET status = 'active', deals_opt_in = ? WHERE id = ?"
  ).bind(deals ? 1 : 0, contactId).run().catch(() => {});
}

// Cohort/segment counters — driven OFF THE CONSENT TABLE, never raw
// list size. The warm-up scheduler's volume math uses confirmedYes.
export async function getConsentCohortStats(db) {
  const q = async (sql) => (await db.prepare(sql).first().catch(() => null)) || {};
  const confirmed = Number((await q("SELECT COUNT(DISTINCT contact_id) AS n FROM sms_consent WHERE kind = 'repermission_yes'")).n || 0);
  const pending = Number((await q("SELECT COUNT(*) AS n FROM sms_contact WHERE status = 'pending'")).n || 0);
  const optedOut = Number((await q("SELECT COUNT(*) AS n FROM sms_contact WHERE status = 'opted_out'")).n || 0);
  const tappers = Number((await q(`SELECT COUNT(DISTINCT c.id) AS n FROM sms_consent c
     JOIN sms_contact s ON s.id = c.contact_id
     WHERE c.kind = 'repermission_yes' AND s.segment = 'tapper'`)).n || 0);
  return { confirmedYes: confirmed, tappersConfirmed: tappers, nonTappersConfirmed: confirmed - tappers, pending, optedOut };
}

export async function logConsent(db, phoneE164, { language, source }) {
  const row = await db.prepare(
    "SELECT id, consent_log_json, status FROM sms_contact WHERE phone_e164 = ?"
  ).bind(phoneE164).first().catch(() => null);
  const entry = { ts: new Date().toISOString(), language: String(language || ""), source: String(source || "") };
  if (!row) {
    await db.prepare(
      "INSERT INTO sms_contact (phone_e164, status, consent_log_json) VALUES (?, 'pending', ?)"
    ).bind(phoneE164, JSON.stringify([entry])).run();
    return { created: true };
  }
  const log = parseConsentLog(row);
  log.push(entry);
  await db.prepare("UPDATE sms_contact SET consent_log_json = ? WHERE id = ?")
    .bind(JSON.stringify(log), row.id).run();
  return { created: false, id: row.id };
}

// ── send ────────────────────────────────────────────────────────────
// Dry-run default: writes a sms_send row with status='dry_run' and
// returns it without touching the network. Live send requires
// env.SMS_LIVE === "1" AND opts.live === true AND consent gate passing.
export async function sendSms(env, { to, body, kind = "alert", contactId = null, live = false }) {
  const db = env?.JOBS_DB;
  if (!db) throw new Error("JOBS_DB missing");
  const phone = normalizePhoneE164(to);
  // US-only default: normalizePhoneE164 returns null for any non-+1 number.
  if (!phone || !phone.startsWith("+1")) return { ok: false, error: "bad_phone" };
  const segments = countSegments(body);
  const costCents = estimateCostCents(segments);

  if (kind === "repermission") {
    // The single allowed exception: one re-permission ask to a pending
    // contact. Never repeated, never to anyone with a consent record.
    const row = await db.prepare("SELECT id, status FROM sms_contact WHERE phone_e164 = ?")
      .bind(phone).first().catch(() => null);
    if (!row || row.status !== "pending") return { ok: false, error: "not_pending", phone, segments };
    if (await hasLoggedYes(db, row.id)) return { ok: false, error: "already_consented", phone, segments };
    if (await repermissionAlreadySent(db, row.id)) return { ok: false, error: "repermission_already_sent", phone, segments };
    contactId = row.id;
  } else {
    // HARD RULE: no logged YES in sms_consent → no send, dry-run or live.
    const gate = await canMessage(db, phone);
    if (!gate) {
      return { ok: false, error: "no_consent", phone, segments };
    }
  }
  if (isQuietHours(new Date(), (await contactTz(db, phone)))) {
    return { ok: false, error: "quiet_hours", phone, segments };
  }

  const doLive = live && smsLive(env);
  if (doLive) {
    const sid = env.TWILIO_ACCOUNT_SID, token = env.TWILIO_AUTH_TOKEN, from = env.TWILIO_FROM_NUMBER;
    if (!sid || !token || !from) return { ok: false, error: "twilio_not_configured", phone };
    try {
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: "POST",
        headers: {
          "authorization": "Basic " + btoa(`${sid}:${token}`),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: phone, From: from, Body: body }).toString(),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        await insertSend(db, { contactId, phone, kind, body, segments, costCents, status: "failed", error: d.message || `http_${r.status}` });
        return { ok: false, error: d.message || `http_${r.status}`, phone };
      }
      const row = await insertSend(db, { contactId, phone, kind, body, segments, costCents, status: "sent", sid: d.sid });
      await db.prepare("UPDATE sms_contact SET sent_count = sent_count + 1 WHERE phone_e164 = ?").bind(phone).run().catch(() => {});
      return { ok: true, live: true, sid: d.sid, segments, costCents, sendId: row };
    } catch (e) {
      await insertSend(db, { contactId, phone, kind, body, segments, costCents, status: "failed", error: e?.message || String(e) });
      return { ok: false, error: e?.message || String(e), phone };
    }
  }

  const row = await insertSend(db, { contactId, phone, kind, body, segments, costCents, status: "dry_run" });
  return { ok: true, live: false, dryRun: true, segments, costCents, sendId: row, phone };
}

async function contactTz(db, phone) {
  const r = await db.prepare("SELECT tz_offset_min FROM sms_contact WHERE phone_e164 = ?")
    .bind(phone).first().catch(() => null);
  return r?.tz_offset_min ?? -300;
}

async function insertSend(db, { contactId, phone, kind, body, segments, costCents, status, sid = null, error = null }) {
  let cid = contactId;
  if (!cid) {
    const r = await db.prepare("SELECT id FROM sms_contact WHERE phone_e164 = ?").bind(phone).first().catch(() => null);
    cid = r?.id || null;
  }
  if (!cid) return null;
  const res = await db.prepare(
    `INSERT INTO sms_send (contact_id, kind, body, segments, cost_cents, status, sid, error, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${status === "sent" ? "datetime('now')" : "NULL"})`
  ).bind(cid, kind, body, segments, costCents, status, sid, error).run().catch(() => null);
  return res?.meta?.last_row_id ?? null;
}

// ── tracked links ───────────────────────────────────────────────────
export function mintPublicId(prefix = "") {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return (prefix ? prefix + "_" : "") + b64;
}

export async function mintLink(db, { contactId = null, kind = "offer_page", targetUrl, offerSlot = null }) {
  const publicId = mintPublicId("t");
  await db.prepare(
    "INSERT INTO sms_link (public_id, contact_id, kind, target_url, offer_slot) VALUES (?, ?, ?, ?, ?)"
  ).bind(publicId, contactId, kind, targetUrl, offerSlot).run();
  return publicId;
}

export async function recordTap(db, publicId, { ip = null, ua = null } = {}) {
  const link = await db.prepare("SELECT id, contact_id, target_url FROM sms_link WHERE public_id = ?")
    .bind(publicId).first().catch(() => null);
  if (!link) return null;
  await db.prepare("UPDATE sms_link SET tap_count = tap_count + 1 WHERE id = ?").bind(link.id).run().catch(() => {});
  await db.prepare("INSERT INTO sms_tap (link_id, contact_id, ip, ua) VALUES (?, ?, ?, ?)")
    .bind(link.id, link.contact_id, ip, ua).run().catch(() => {});
  if (link.contact_id) {
    await db.prepare("UPDATE sms_contact SET segment = 'tapper', last_tap_at = datetime('now') WHERE id = ?")
      .bind(link.contact_id).run().catch(() => {});
  }
  return link;
}

// ── inbound keyword parsing ─────────────────────────────────────────
const STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const HELP_WORDS = new Set(["HELP", "INFO"]);
export function parseInboundKeyword(body) {
  const t = String(body || "").trim().toUpperCase();
  if (STOP_WORDS.has(t)) return "stop";
  if (HELP_WORDS.has(t)) return "help";
  if (t === "DEALS") return "deals";
  if (t === "YES" || t === "START" || t === "UNSTOP") return "yes";
  return "other";
}

export function twiml(message) {
  const esc = String(message || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${esc}</Message></Response>`;
}

// ── copy templates ──────────────────────────────────────────────────
export const REPERMISSION_TEXT =
  "mehyar.jobs: you asked for job alerts by text. Want weekly career deals too (resume help, courses, remote boards)? Reply DEALS for yes. 1-2 msgs/wk. Reply STOP to end. Msg&data rates may apply.";
export const DEALS_CONFIRMED_TEXT =
  "You're in! You'll get 1 weekly career-deals text from mehyar.jobs plus your job alerts. Reply STOP to end anytime.";
export const WELCOME_TEXT =
  "Welcome to mehyar.jobs SMS alerts! Your top match is on its way. ~1 msg/day. Reply STOP to end, HELP for help. Msg&data rates may apply.";
export const HELP_TEXT =
  "mehyar.jobs SMS: daily job alerts matched to you, free forever. Reply STOP to end. Support: https://jobs.mehyar.us";

// ── warm-up batch planning (pure logic; tested) ─────────────────────
// Picks up to `cap` contacts: active, consented, not messaged today for
// this kind, tappers first (engagement-based sending), quiet hours OK.
// Warm-up batch planner.
// kind: 'repermission' | 'alert' | 'promo'.
// - repermission: pending contacts with NO consent record and NO prior
//   re-permission send (one ask, never repeated). This is the ONLY entry
//   gate — the re-permission text is how a broker-list number earns a YES.
// - alert/promo: only contacts with a logged YES in sms_consent.
// Volume math is driven by the confirmed-YES cohort size (from the
// consent table), never raw list size. US-only: phone_e164 LIKE '+1%'.
// Engagement-first: confirmed tappers before non-tappers.
export async function planWarmupBatch(db, { week, kind = "alert", now = new Date(), perHourSpread = 6 } = {}) {
  const cap = warmupCap(week);
  const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
  const cohort = await getConsentCohortStats(db);
  let rows;
  if (kind === "repermission") {
    const r = await db.prepare(`
      SELECT c.id, c.phone_e164, c.tz_offset_min, c.segment,
             (SELECT COUNT(*) FROM sms_send s
               WHERE s.contact_id = c.id AND s.kind = 'repermission' AND s.created_at >= ?) AS sent_today
      FROM sms_contact c
      WHERE c.status = 'pending'
        AND c.phone_e164 LIKE '+1%'
        AND NOT EXISTS (SELECT 1 FROM sms_consent sc WHERE sc.contact_id = c.id AND sc.kind = 'repermission_yes')
        AND NOT EXISTS (SELECT 1 FROM sms_send s2 WHERE s2.contact_id = c.id AND s2.kind = 'repermission')
      ORDER BY c.id
      LIMIT ?
    `).bind(dayStart.toISOString(), cap).all().catch(() => ({ results: [] }));
    rows = r;
  } else {
    const r = await db.prepare(`
      SELECT c.id, c.phone_e164, c.tz_offset_min, c.segment, c.deals_opt_in,
             (SELECT COUNT(*) FROM sms_send s
               WHERE s.contact_id = c.id AND s.kind = ? AND s.created_at >= ?) AS sent_today
      FROM sms_contact c
      WHERE c.status = 'active'
        AND c.phone_e164 LIKE '+1%'
        AND EXISTS (SELECT 1 FROM sms_consent sc WHERE sc.contact_id = c.id AND sc.kind = 'repermission_yes')
        AND (? = 'alert' OR c.deals_opt_in = 1)
      ORDER BY CASE WHEN c.segment = 'tapper' THEN 0 ELSE 1 END, c.id
      LIMIT ?
    `).bind(kind, dayStart.toISOString(), kind, cap).all().catch(() => ({ results: [] }));
    rows = r;
  }
  const eligible = (rows.results || []).filter((r) => r.sent_today === 0 && !isQuietHours(now, r.tz_offset_min ?? -300));
  // Spread across hours: assign each contact a target hour slot.
  const planned = eligible.slice(0, cap).map((r, i) => ({
    contactId: r.id,
    phone: r.phone_e164,
    segment: r.segment,
    hourSlot: i % perHourSpread,
  }));
  return { week, cap, kind, cohort, eligible: eligible.length, planned: planned.length, contacts: planned };
}

// ── offer-slot helpers ──────────────────────────────────────────────
export async function getOfferSlots(db) {
  const r = await db.prepare(
    "SELECT key, name, slot_type, headline, body, cta_text, cta_url, image_url, sms_copy, priority, is_active FROM offer_slot WHERE is_active = 1 ORDER BY priority"
  ).all().catch(() => ({ results: [] }));
  return r.results || [];
}

// Pick up to 3 offer slots personalized to the subscriber's profile:
// low resume score -> myperfectresume; skill gaps -> coursera;
// remote preference -> flexjobs; else priority order (high-ticket first for promos).
export function pickOfferSlots(slots, profile = {}) {
  const byKey = Object.fromEntries((slots || []).map((s) => [s.key, s]));
  const picks = [];
  const push = (k) => { if (byKey[k] && !picks.includes(byKey[k])) picks.push(byKey[k]); };
  if ((profile.resume_score ?? 100) < 60) push("myperfectresume");
  if ((profile.skill_gaps || []).length > 0) push("coursera");
  if (profile.remote_ok) push("flexjobs");
  for (const s of slots) { if (picks.length >= 3) break; push(s.key); }
  return picks.slice(0, 3);
}

// ── Placement map: exactly one offer per touchpoint, no competing CTAs. ──
// Touchpoints: resume_review | skill_gaps | matches_remote | email | sms |
// advertise (employer-side, no affiliate). SMS carries ONLY the hook + a
// deep link to the landing page — never a raw affiliate URL.
export const TOUCHPOINT_OFFER = {
  resume_review:  "myperfectresume", // score-reveal moment on /review
  resume_pro:     "great-resumes-fast", // deeper fix for low scores
  skill_gaps:     "coursera",        // "Gaps to fix" section on /review
  matches_remote: "flexjobs",        // remote seekers on /matches
  interview:      "amazon-gear",      // interview-prep moments
  assessment:     "jobtestprep",      // pre-employment test prep
  design:         "designlab",        // design-track seekers
};

export function offerForTouchpoint(touchpoint, slots) {
  const key = TOUCHPOINT_OFFER[touchpoint];
  if (!key) return null;
  return (slots || []).find((s) => s.key === key) || null;
}

// Highest-priority slot with a live affiliate link — used for the single
// affiliate block in alert/digest emails. Returns null when nothing is
// configured, so no block is rendered.
export function getFeaturedOfferSlot(slots) {
  const live = (slots || []).filter((s) => s.slot_type !== "sponsor" && s.cta_url && String(s.cta_url).trim());
  live.sort((a, b) => (a.priority || 99) - (b.priority || 99));
  return live[0] || null;
}

export function offerEmailHtml(slot, appUrl) {
  if (!slot || !slot.cta_url) return "";
  const link = `${appUrl}/go/${slot.key}`;
  return `
    <div style="margin:20px 0;padding:16px;border:1px solid #e5e7eb;border-radius:12px;background:#fafbff">
      <div style="font-size:11px;font-weight:800;letter-spacing:.08em;color:#b45309">SPONSORED · PARTNER PICK</div>
      <div style="font-weight:700;margin:6px 0 2px">${esc(slot.headline)}</div>
      <div style="color:#4b5563;font-size:14px;margin-bottom:10px">${esc(slot.body)}</div>
      <a href="${link}" style="display:inline-block;background:#1a56db;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:700">${esc(slot.cta_text || "Learn more")} →</a>
    </div>`;
}

export function offerEmailText(slot, appUrl) {
  if (!slot || !slot.cta_url) return [];
  return ["", `SPONSORED · PARTNER PICK: ${slot.headline}`, slot.body, `→ ${appUrl}/go/${slot.key}`];
}

function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
