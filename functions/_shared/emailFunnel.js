// _shared/emailFunnel.js
//
// Daily send-list algorithm for the email warm-up funnel.
//
//   DAILY LIST = engaged core (bands high+moderate) + at-risk (win-back
//   variant only) + fresh legacy contacts filling the remainder.
//   The current Fibonacci warm-up level caps TOTAL daily sends combined:
//   the engaged core + win-backs may use at most (level - reserve), and a
//   configurable fraction of the level (LEGACY_RESERVE_FRAC, default 0.5)
//   is reserved for new legacy contacts so list growth never stalls.
//   Prune after 5 sends with no engagement. Hard bounce, complaint, or
//   unsubscribe suppresses instantly.
//
//   Fibonacci levels are GATES, not daily steps: each level is held 2-3
//   days and advances only when complaints <0.10%, hard bounce <2%,
//   Postmaster reputation Medium+, and zero blocklist hits.
//
//   ESP abstraction: SMTP2GO for aged legacy cohorts, Brevo for warm/
//   fresh mehyar.jobs segments, separate sending subdomains.
//   DRY-RUN BY DEFAULT: nothing sends unless { live: true } AND
//   EMAIL_LIVE=1 in env. No credentials in the repo.

// ── CAN-SPAM physical address ────────────────────────────────────────
// Every US commercial email must carry the sender's valid physical
// mailing address. Source of truth: env PHYSICAL_ADDRESS (or
// MAYOR_PHYSICAL_ADDRESS — PATCHed to runtime as plain_text in the
// deploy dance; the value never lives in the repo). Until a real address
// is configured, renders fall back to the clearly-marked placeholder
// below, which MUST be replaced before EMAIL_LIVE=1.
//
// NOTE: the placeholder deliberately avoids em dashes — the footer em
// dash in legacy copy already uses the one allowed per render.
export const PHYSICAL_ADDRESS_PLACEHOLDER =
  "PHYSICAL ADDRESS PLACEHOLDER (set before sending)";

export function physicalAddress(env = {}) {
  const v = String(env?.PHYSICAL_ADDRESS || env?.MAYOR_PHYSICAL_ADDRESS || "").trim();
  return v || PHYSICAL_ADDRESS_PLACEHOLDER;
}

export const FIB_LEVELS = (() => {
  const out = [5, 10];
  while (out.length < 30) out.push(out[out.length - 1] + out[out.length - 2]);
  return out;
})();

export const GATE = {
  COMPLAINT_PCT_MAX: 0.10,
  BOUNCE_PCT_MAX: 2,
  COMPLAINT_PCT_PAUSE: 0.30,
  BOUNCE_PCT_PAUSE: 5,
  HOLD_DAYS: 3,
  NO_ENGAGEMENT_PRUNE: 5,   // sends with no engagement -> sunset pool
  WINBACK_MAX: 3,           // win-back emails before suppression
  WINBACK_GAP_DAYS: 10,
  WEEKLY_CAP: 4,            // max sends/week below super-engager
  OUTLOOK_SHARE_MAX: 0.25,  // Outlook/Hotmail throttled: later + slower
  SEED_INBOX_MIN: 80,
  SEED_SPAM_MAX: 5,
};

// ── helpers ──────────────────────────────────────────────────────────

export function dayStr(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export function isoWeekStart(d = new Date()) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (x.getUTCDay() + 6) % 7; // Monday = 0
  x.setUTCDate(x.getUTCDate() - dow);
  return x.toISOString().slice(0, 10);
}

export function daysAgo(n, now = new Date()) {
  return new Date(now.getTime() - n * 86400000).toISOString();
}

export function providerOf(email) {
  const dom = String(email || "").trim().toLowerCase().split("@")[1] || "";
  if (dom === "gmail.com" || dom === "googlemail.com") return "gmail";
  if (["outlook.com", "hotmail.com", "live.com", "msn.com", "outlook.es", "hotmail.es"].includes(dom)) return "outlook";
  if (dom === "yahoo.com" || dom === "ymail.com" || dom.endsWith(".yahoo.com")) return "yahoo";
  if (["icloud.com", "me.com", "mac.com"].includes(dom)) return "apple";
  return "other";
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || "").trim().toLowerCase());
}

// Fraction of the daily Fibonacci cap reserved for fresh legacy contacts.
// Env LEGACY_RESERVE_FRAC (default 0.5), clamped to [0, 1]. The engaged
// core + win-backs may then use at most (cap - reserve).
export function legacyReserveFrac(env = {}) {
  const raw = parseFloat(env?.LEGACY_RESERVE_FRAC);
  if (!Number.isFinite(raw)) return 0.5;
  return Math.min(1, Math.max(0, raw));
}

// Deterministic string hash (djb2) — stable per recipient per day without
// async crypto, so subject rotation is reproducible on the edge.
export function hashStr(s) {
  let h = 5381;
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h;
}

// Subject-line spintax for the digest: 5 rotating variants (2 for win-back),
// picked by hash(email + date) so each recipient sees a stable subject per
// day while the list as a whole doesn't share one fingerprint.
// Copy rules: job-match themed, personal, non-spammy — no "FREE", no
// excessive caps or punctuation.
export function digestSubject({ email, firstName, roleTitle, matches, variant = "standard", dateStr = null, extraSubjects = [] }) {
  const em = String(email || "").trim().toLowerCase();
  const ds = dateStr || new Date().toISOString().slice(0, 10);
  const name = String(firstName || "").trim();
  const role = String(roleTitle || "").trim();
  const ms = Array.isArray(matches) ? matches : [];
  const n = Math.max(ms.length, 1);
  const plural = n === 1 ? "" : "es";
  const topTitle = ms[0]?.title ? String(ms[0].title).trim() : "";

  let pool;
  if (variant === "winback") {
    pool = [
      name ? `${name}, still on the hunt? Your matches this week` : `Still on the hunt? Your matches this week`,
      `This week's top matches, saved for you`,
    ];
  } else {
    pool = [
      name ? `${name}, your top ${n} job match${plural} today` : `Your top ${n} job match${plural} today`,
      role ? `New ${role} roles picked for you` : `New roles picked for you today`,
      topTitle && n >= 2 ? `${topTitle}, plus ${n - 1} more for you` : (name ? `${name}, ${n} new match${plural} to review` : `${n} new match${plural} to review`),
      `Your daily job picks are ready`,
      name ? `${name}: fresh matches worth a look` : `Fresh matches worth a look`,
    ];
  }
  // Campaign-brain subject tweaks: appended to the pool. The pick stays
  // stable per recipient per day via hash(email|dateStr).
  const full = pool.concat((Array.isArray(extraSubjects) ? extraSubjects : []).map(String).filter(Boolean));
  return full[hashStr(`${em}|${ds}`) % full.length];
}

// Engagement band from last click (primary) / last open (secondary).
// Apple-proxy (MPP) opens never set last_open_at — see recordEmailEvent.
export function classifyBand({ lastClickAt, lastOpenAt, now = new Date() }) {
  const t = now.getTime();
  const d = (iso) => (iso ? (t - new Date(iso).getTime()) / 86400000 : Infinity);
  const dc = d(lastClickAt), dopen = d(lastOpenAt);
  if (dc <= 30) return "high";
  if (dc <= 90 || dopen <= 30) return "moderate";
  if (dc <= 180 || dopen <= 90) return "at_risk";
  return "inactive";
}

function addDaysIso(iso, n) {
  return new Date(new Date(iso).getTime() + n * 86400000).toISOString();
}

// ── engagement ───────────────────────────────────────────────────────

export async function ensureEngagementRow(db, contactId) {
  await db.prepare(
    "INSERT OR IGNORE INTO contact_engagement (contact_id) VALUES (?)"
  ).bind(contactId).run();
}

const EVENT_KIND_MAP = {
  open: "open", opened: "open",
  click: "click", clicked: "click",
  hard_bounce: "hard_bounce", bounce: "hard_bounce", bounced: "hard_bounce",
  soft_bounce: "soft_bounce", deferred: "soft_bounce",
  complaint: "complaint", spam: "complaint", abuse: "complaint",
  unsubscribe: "unsubscribe", unsubscribed: "unsubscribe", list_unsubscribe: "unsubscribe",
};

export function normalizeEventKind(raw) {
  return EVENT_KIND_MAP[String(raw || "").toLowerCase().trim()] || null;
}

// Record one webhook event. Returns { ok, action } where action is one of:
// engaged | mpp_open | suppressed | opted_out | ignored.
export async function recordEmailEvent(db, email, rawKind, opts = {}) {
  const kind = normalizeEventKind(rawKind);
  const em = String(email || "").trim().toLowerCase();
  if (!kind || !isValidEmail(em)) return { ok: false, action: "ignored" };
  const contact = await db.prepare("SELECT id, status FROM email_contact WHERE email = ?").bind(em).first();
  if (!contact) return { ok: false, action: "ignored" };
  const now = new Date().toISOString();
  const mppSuspect = kind === "open" && opts.mppSuspect === true ? 1 : 0;

  // Product + day-slug attribution: if this event's meta doesn't carry a
  // product/go_slug tag, copy it from the contact's latest product-woven
  // send so the campaign report's meta_json aggregation (campaignReport.js)
  // and the landing-stats admin API see it. Never breaks event ingestion —
  // the lookup is best-effort.
  const meta = { ...(opts.meta || {}) };
  if (!meta.product || !meta.go_slug) {
    try {
      const last = await db.prepare(
        `SELECT meta_json FROM email_send
         WHERE contact_id = ? AND meta_json LIKE '%"product"%' AND status IN ('sent', 'dry_run')
         ORDER BY id DESC LIMIT 1`
      ).bind(contact.id).first();
      if (last?.meta_json) {
        const mj = JSON.parse(last.meta_json);
        if (!meta.product && mj?.product) meta.product = String(mj.product);
        if (!meta.go_slug && mj?.go_slug) meta.go_slug = String(mj.go_slug);
      }
    } catch { /* ignore — engagement counting is what matters */ }
  }

  await db.prepare(
    "INSERT INTO email_event (contact_id, kind, mpp_suspect, meta_json) VALUES (?, ?, ?, ?)"
  ).bind(contact.id, kind, mppSuspect, JSON.stringify(meta)).run();
  await ensureEngagementRow(db, contact.id);

  if (kind === "hard_bounce" || kind === "complaint") {
    const reason = kind === "hard_bounce" ? "hard_bounce" : "complaint";
    await db.prepare("UPDATE email_contact SET status = 'suppressed' WHERE id = ?").bind(contact.id).run();
    await db.prepare(
      "UPDATE contact_engagement SET suppressed_at = ?, suppress_reason = ?, updated_at = ? WHERE contact_id = ?"
    ).bind(now, reason, now, contact.id).run();
    return { ok: true, action: "suppressed", reason };
  }
  if (kind === "unsubscribe") {
    await db.prepare("UPDATE email_contact SET status = 'opted_out' WHERE id = ?").bind(contact.id).run();
    await db.prepare(
      "UPDATE contact_engagement SET suppressed_at = ?, suppress_reason = 'unsubscribed', updated_at = ? WHERE contact_id = ?"
    ).bind(now, now, contact.id).run();
    return { ok: true, action: "opted_out" };
  }
  if (kind === "open") {
    if (mppSuspect) {
      // Apple Privacy proxy pre-fetch: counted, never trusted for banding.
      await db.prepare(
        "UPDATE contact_engagement SET mpp_suspect_opens = mpp_suspect_opens + 1, updated_at = ? WHERE contact_id = ?"
      ).bind(now, contact.id).run();
      return { ok: true, action: "mpp_open" };
    }
    await db.prepare(
      "UPDATE contact_engagement SET opens = opens + 1, last_open_at = ?, sends_since_engagement = 0, updated_at = ? WHERE contact_id = ?"
    ).bind(now, now, contact.id).run();
  }
  if (kind === "click") {
    await db.prepare(
      "UPDATE contact_engagement SET clicks = clicks + 1, last_click_at = ?, sends_since_engagement = 0, updated_at = ? WHERE contact_id = ?"
    ).bind(now, now, contact.id).run();
  }
  // soft_bounce: logged only; repeated soft bounces are handled by pruning.
  await recomputeBand(db, contact.id);
  return { ok: true, action: "engaged" };
}

export async function recomputeBand(db, contactId, now = new Date()) {
  const e = await db.prepare(
    "SELECT last_open_at, last_click_at, engagement_band FROM contact_engagement WHERE contact_id = ?"
  ).bind(contactId).first();
  if (!e) return null;
  if (e.engagement_band === "fresh") return "fresh"; // fresh until first send
  const band = classifyBand({ lastClickAt: e.last_click_at, lastOpenAt: e.last_open_at, now });
  if (band !== e.engagement_band) {
    await db.prepare(
      "UPDATE contact_engagement SET engagement_band = ?, updated_at = ? WHERE contact_id = ?"
    ).bind(band, now.toISOString(), contactId).run();
  }
  return band;
}

// ── Fibonacci gate state machine ─────────────────────────────────────

export async function getGate(db) {
  let g = await db.prepare("SELECT * FROM fib_gate WHERE id = 1").first().catch(() => null);
  if (!g) {
    await db.prepare("INSERT OR IGNORE INTO fib_gate (id, level_idx, level, status) VALUES (1, 0, 5, 'ramping')").run().catch(() => {});
    g = await db.prepare("SELECT * FROM fib_gate WHERE id = 1").first();
  }
  return g;
}

// Advance / hold / pause the warm-up level. Metrics are measured over the
// current level's sends; postmaster is the manual Postmaster Tools reading
// ("High"|"Medium"|"Low"|"Bad"|null when unknown).
export async function evaluateGate(db, { complaintPct, bouncePct, postmaster = null, blocklistHits = 0, now = new Date() } = {}) {
  const g = await getGate(db);
  const ts = now.toISOString();
  const write = async (patch, notes) => {
    await db.prepare(
      `UPDATE fib_gate SET level_idx = ?, level = ?, status = ?, hold_until = ?,
        postmaster_reputation = ?, last_complaint_pct = ?, last_bounce_pct = ?,
        blocklist_hits = ?, last_evaluated_at = ?, notes = ? WHERE id = 1`
    ).bind(
      patch.level_idx ?? g.level_idx, patch.level ?? g.level, patch.status ?? g.status,
      patch.hold_until ?? null, postmaster, complaintPct ?? null, bouncePct ?? null,
      blocklistHits, ts, notes || null
    ).run();
    return getGate(db);
  };

  // Respect an active hold: no advancement before hold_until.
  if (g.hold_until && new Date(g.hold_until).getTime() > now.getTime() && g.status !== "paused") {
    return { gate: g, decision: "holding", reason: "hold_until not reached" };
  }

  const badReputation = postmaster === "Low" || postmaster === "Bad";
  const critical =
    (complaintPct ?? 0) >= GATE.COMPLAINT_PCT_PAUSE ||
    (bouncePct ?? 0) >= GATE.BOUNCE_PCT_PAUSE ||
    badReputation || blocklistHits > 0;
  if (critical) {
    const reason = badReputation ? `postmaster=${postmaster}`
      : blocklistHits > 0 ? `blocklist_hits=${blocklistHits}`
      : `complaint=${complaintPct}% bounce=${bouncePct}%`;
    const gate = await write({ status: "paused" }, `PAUSED: ${reason}`);
    return { gate, decision: "paused", reason };
  }

  const green =
    (complaintPct ?? 0) < GATE.COMPLAINT_PCT_MAX &&
    (bouncePct ?? 0) < GATE.BOUNCE_PCT_MAX &&
    (postmaster === null || postmaster === "High" || postmaster === "Medium");
  if (green) {
    const nextIdx = Math.min(g.level_idx + 1, FIB_LEVELS.length - 1);
    const gate = await write(
      { level_idx: nextIdx, level: FIB_LEVELS[nextIdx], status: "ramping", hold_until: addDaysIso(ts, 2) },
      `advanced to level ${FIB_LEVELS[nextIdx]}`
    );
    return { gate, decision: "advanced", reason: `metrics green -> ${FIB_LEVELS[nextIdx]}/day` };
  }

  const gate = await write(
    { status: "holding", hold_until: addDaysIso(ts, GATE.HOLD_DAYS) },
    `HOLD: complaint=${complaintPct}% bounce=${bouncePct}% postmaster=${postmaster}`
  );
  return { gate, decision: "holding", reason: "metrics not green" };
}

// ── pre-send seed-test gate ──────────────────────────────────────────

export async function preSendGateCheck(db, template) {
  const t = await db.prepare(
    "SELECT inbox_pct, spam_pct, tested_at FROM seed_test WHERE template = ? ORDER BY id DESC LIMIT 1"
  ).bind(template).first();
  if (!t) return { ok: false, reason: "no seed test on record for template" };
  if (t.inbox_pct < GATE.SEED_INBOX_MIN) return { ok: false, reason: `inbox ${t.inbox_pct}% < ${GATE.SEED_INBOX_MIN}%` };
  if (t.spam_pct > GATE.SEED_SPAM_MAX) return { ok: false, reason: `spam ${t.spam_pct}% > ${GATE.SEED_SPAM_MAX}%` };
  return { ok: true, inbox_pct: t.inbox_pct, spam_pct: t.spam_pct, tested_at: t.tested_at };
}

export async function recordSeedTest(db, { template, inboxPct, spamPct, notes = "" }) {
  await db.prepare(
    "INSERT INTO seed_test (template, inbox_pct, spam_pct, notes) VALUES (?, ?, ?, ?)"
  ).bind(template, inboxPct, spamPct, notes).run();
  return { ok: true };
}

// ── daily list builder ───────────────────────────────────────────────

function isSuperEngager(eng, now) {
  if (!eng?.last_click_at) return false;
  return (now.getTime() - new Date(eng.last_click_at).getTime()) / 86400000 <= 7;
}

// Build today's send list. Returns { list, cap, gate, counts }.
// The Fibonacci level caps TOTAL daily sends combined: the engaged core +
// win-backs may use at most (cap - reserve), where reserve =
// floor(cap * LEGACY_RESERVE_FRAC) is set aside for fresh legacy contacts;
// fresh contacts then fill the remainder of the cap. Total selected never
// exceeds the level. Does NOT send — queueDailySends() does that.
export async function buildDailyList(db, { now = new Date(), limit = null, env = {} } = {}) {
  const gate = await getGate(db);
  const cap = gate.status === "paused" ? 0 : (limit || gate.level);
  const today = dayStr(now);
  const week = isoWeekStart(now);

  // Weekly counter rollover.
  await db.prepare(
    "UPDATE email_contact SET week_sent_count = 0, week_start = ? WHERE week_start IS NULL OR week_start != ?"
  ).bind(week, week).run();

  const reserve = Math.floor(cap * legacyReserveFrac(env));
  // Engaged core + win-backs share this budget; the reserve stays protected
  // for fresh legacy contacts so list growth never stalls.
  const engagedBudget = Math.max(0, cap - reserve);
  const counts = { core: 0, winback: 0, fresh: 0, skipped_outlook_cap: 0, reserve };

  if (cap <= 0) return { list: [], cap, gate, counts, blocked: gate.status === "paused" ? "gate_paused" : null };

  // 1) Engaged core: active contacts, bands high+moderate, not sent today, weekly cap ok.
  const coreRows = await db.prepare(
    `SELECT ec.*, ce.engagement_band, ce.last_click_at, ce.last_open_at,
            ce.sends_since_engagement, ce.winback_stage
     FROM email_contact ec
     JOIN contact_engagement ce ON ce.contact_id = ec.id
     WHERE ec.status = 'active'
       AND ce.engagement_band IN ('high', 'moderate')
       AND (ec.last_sent_at IS NULL OR substr(ec.last_sent_at, 1, 10) != ?)
       AND (ec.week_sent_count < ? OR ce.last_click_at >= ?)
     ORDER BY ce.last_click_at DESC NULLS LAST
     LIMIT ?`
  ).bind(today, GATE.WEEKLY_CAP, daysAgo(7, now), engagedBudget).all().then(r => r.results || []);

  // 2) At-risk: re-engagement variant only, winback_stage < 3.
  const engagedRemaining = engagedBudget - coreRows.length;
  const riskRows = engagedRemaining > 0 ? await db.prepare(
    `SELECT ec.*, ce.engagement_band, ce.last_click_at, ce.last_open_at,
            ce.sends_since_engagement, ce.winback_stage
     FROM email_contact ec
     JOIN contact_engagement ce ON ce.contact_id = ec.id
     WHERE ec.status = 'active'
       AND ce.engagement_band = 'at_risk'
       AND ce.winback_stage < ?
       AND (ec.last_sent_at IS NULL OR substr(ec.last_sent_at, 1, 10) != ?)
     ORDER BY ce.last_click_at DESC NULLS LAST
     LIMIT ?`
  ).bind(GATE.WINBACK_MAX, today, engagedRemaining).all().then(r => r.results || []) : [];

  // 3) Fresh legacy contacts fill the remainder of the level cap.
  const freshRemaining = cap - coreRows.length - riskRows.length;
  const freshRows = freshRemaining > 0 ? await db.prepare(
    `SELECT ec.*, 'fresh' AS engagement_band, NULL AS last_click_at, NULL AS last_open_at,
            0 AS sends_since_engagement, 0 AS winback_stage
     FROM email_contact ec
     WHERE ec.status = 'pending' AND ec.sent_count = 0
     ORDER BY ec.imported_at DESC
     LIMIT ?`
  ).bind(freshRemaining).all().then(r => r.results || []) : [];

  const picked = [
    ...coreRows.map(r => ({ ...r, variant: "standard" })),
    ...riskRows.map(r => ({ ...r, variant: "winback" })),
    ...freshRows.map(r => ({ ...r, variant: "standard" })),
  ];
  counts.core = coreRows.length;
  counts.winback = riskRows.length;
  counts.fresh = freshRows.length;

  // 4) Provider pacing: Gmail first; Outlook/Hotmail capped at 25% and sent late.
  const outlookMax = Math.max(1, Math.floor(picked.length * GATE.OUTLOOK_SHARE_MAX));
  let outlookUsed = 0;
  const list = [];
  const gmailFirst = [...picked].sort((a, b) =>
    (a.provider === "gmail" ? 0 : 1) - (b.provider === "gmail" ? 0 : 1));
  for (const r of gmailFirst) {
    const isOutlook = r.provider === "outlook";
    if (isOutlook && outlookUsed >= outlookMax) { counts.skipped_outlook_cap++; continue; }
    if (isOutlook) outlookUsed++;
    list.push({
      contactId: r.id,
      email: r.email,
      firstName: r.first_name,
      lastName: r.last_name,
      city: r.city,
      state: r.state,
      roleTitle: r.role_title,
      source: r.source,
      provider: r.provider,
      band: r.engagement_band,
      variant: r.variant,
      sendLate: isOutlook, // throttled: later in the day, slower
    });
  }
  return { list, cap, gate, counts };
}

// ── pruning / sunset ─────────────────────────────────────────────────

// Move no-engagement contacts to the sunset pool; advance win-back stages.
// Returns { sunsetted, winbackAdvanced, suppressed }.
export async function pruneContacts(db, { now = new Date() } = {}) {
  const nowIso = now.toISOString();
  let sunsetted = 0, winbackAdvanced = 0, suppressed = 0;

  // 5+ sends, no engagement, not already in sunset -> sunset pool.
  const stale = await db.prepare(
    `SELECT ec.id FROM email_contact ec
     JOIN contact_engagement ce ON ce.contact_id = ec.id
     WHERE ec.status = 'active'
       AND ce.sends_since_engagement >= ?
       AND ce.engagement_band NOT IN ('high', 'moderate')`
  ).bind(GATE.NO_ENGAGEMENT_PRUNE).all().then(r => r.results || []);
  for (const s of stale) {
    await db.prepare("UPDATE email_contact SET status = 'sunset' WHERE id = ?").bind(s.id).run();
    await db.prepare(
      "UPDATE contact_engagement SET winback_stage = 0, updated_at = ? WHERE contact_id = ?"
    ).bind(nowIso, s.id).run();
    sunsetted++;
  }

  // Sunset pool: up to WINBACK_MAX win-backs, 10+ days apart, then suppress.
  const due = await db.prepare(
    `SELECT ec.id, ce.winback_stage,
            (SELECT MAX(sent_at) FROM email_send WHERE contact_id = ec.id AND kind = 'winback') AS last_wb
     FROM email_contact ec
     JOIN contact_engagement ce ON ce.contact_id = ec.id
     WHERE ec.status = 'sunset' AND ce.winback_stage < ?`
  ).bind(GATE.WINBACK_MAX).all().then(r => r.results || []);
  const dueIds = [];
  for (const d of due) {
    if (!d.last_wb || (now.getTime() - new Date(d.last_wb).getTime()) / 86400000 >= GATE.WINBACK_GAP_DAYS) {
      dueIds.push(d.id);
    }
  }
  const done = await db.prepare(
    `SELECT ec.id FROM email_contact ec
     JOIN contact_engagement ce ON ce.contact_id = ec.id
     WHERE ec.status = 'sunset' AND ce.winback_stage >= ?`
  ).bind(GATE.WINBACK_MAX).all().then(r => r.results || []);
  for (const d of done) {
    await db.prepare("UPDATE email_contact SET status = 'suppressed' WHERE id = ?").bind(d.id).run();
    await db.prepare(
      "UPDATE contact_engagement SET suppressed_at = ?, suppress_reason = 'sunset', updated_at = ? WHERE contact_id = ?"
    ).bind(nowIso, nowIso, d.id).run();
    suppressed++;
  }
  return { sunsetted, winbackAdvanced, suppressed, winbackDue: dueIds };
}

// ── personalization ──────────────────────────────────────────────────

function extractResumeScore(llmJson) {
  if (!llmJson) return null;
  try {
    const j = typeof llmJson === "string" ? JSON.parse(llmJson) : llmJson;
    for (const k of ["score", "overall_score", "fit_score", "resume_score", "rating"]) {
      const v = j?.[k];
      if (typeof v === "number" && v >= 0 && v <= 100) return Math.round(v);
    }
    // nested shapes: { review: { score } } etc.
    for (const v of Object.values(j || {})) {
      if (v && typeof v === "object") {
        const s = extractResumeScore(v);
        if (s !== null) return s;
      }
    }
  } catch { /* ignore */ }
  return null;
}

// Top-3 job matches + resume fit score (or null). Legacy contacts fall back
// to role_title/state keyword matching. Never invents scores.
export async function personalizeForContact(db, contact) {
  const em = String(contact.email || "").trim().toLowerCase();
  const user = await db.prepare("SELECT id FROM app_user WHERE email = ?").bind(em).first().catch(() => null);
  let matches = [];
  let resumeScore = null;
  let hasResume = false;

  if (user) {
    const rows = await db.prepare(
      `SELECT j.title, j.location, j.url, j.salary_min, j.salary_max, j.remote_policy,
              c.name AS company, ujf.score
       FROM user_job_fit ujf
       JOIN job j ON j.id = ujf.job_id
       LEFT JOIN company c ON c.id = j.company_id
       WHERE ujf.user_id = ? AND ujf.hard_no = 0 AND j.is_active = 1
       ORDER BY ujf.score DESC LIMIT 3`
    ).bind(user.id).all().then(r => r.results || []).catch(() => []);
    matches = rows;
    const resume = await db.prepare(
      "SELECT llm_review_json FROM user_resume WHERE user_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 1"
    ).bind(user.id).first().catch(() => null);
    if (resume) {
      hasResume = true;
      resumeScore = extractResumeScore(resume.llm_review_json);
    }
  }

  if (!matches.length) {
    // Legacy fallback: role title keywords + state.
    const words = String(contact.roleTitle || contact.role_title || "")
      .toLowerCase().split(/[^a-z0-9+#]+/).filter(w => w.length > 2).slice(0, 4);
    const state = String(contact.state || "").trim();
    let where = "j.is_active = 1";
    const params = [];
    if (words.length) {
      where += " AND (" + words.map(() => "LOWER(j.title) LIKE ?").join(" OR ") + ")";
      for (const w of words) params.push(`%${w}%`);
    }
    if (state) { where += " AND (j.location LIKE ? OR j.remote_policy = 'remote')"; params.push(`%${state}%`); }
    const rows = await db.prepare(
      `SELECT j.title, j.location, j.url, j.salary_min, j.salary_max, j.remote_policy,
              c.name AS company, NULL AS score
       FROM job j LEFT JOIN company c ON c.id = j.company_id
       WHERE ${where} ORDER BY j.posted_at DESC LIMIT 3`
    ).bind(...params).all().then(r => r.results || []).catch(() => []);
    matches = rows;
  }

  return { matches, resumeScore, hasResume };
}

function fmtSalary(m) {
  if (m.salary_min && m.salary_max) {
    const k = (n) => n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
    return `$${k(m.salary_min)}–$${k(m.salary_max)}`;
  }
  if (m.salary_max) return `up to $${Math.round(m.salary_max / 1000)}k`;
  return "";
}

// Renders the daily digest email. Copy rule: NEVER promise or guarantee
// interviews/jobs — the CTA reveals what's blocking their applications.
// Subject uses digestSubject() spintax: stable per recipient per day via
// hash(email + dateStr), so identical sends don't share one fingerprint.
export function renderDigestEmail({ contact, personalization, weave = null, unsubUrl, appUrl, variant = "standard", stream = "opted_in", address = PHYSICAL_ADDRESS_PLACEHOLDER, dateStr = null, extraSubjects = [], goSlugUrl = null }) {
  const name = (contact.firstName || contact.first_name || "").trim();
  const greeting = name ? `Hi ${name},` : "Hi,";
  const { matches, resumeScore, hasResume } = personalization;

  const subject = digestSubject({
    email: contact.email,
    firstName: name,
    roleTitle: contact.roleTitle || contact.role_title,
    matches,
    variant,
    dateStr,
    extraSubjects,
  });

  const matchRows = matches.map((m) => {
    const sal = fmtSalary(m);
    const loc = [m.location, m.remote_policy === "remote" ? "Remote" : ""].filter(Boolean).join(" · ");
    return `<tr><td style="padding:12px 0;border-bottom:1px solid #eee">
      <a href="${m.url}" style="color:#1a73e8;font-weight:bold;text-decoration:none">${esc(m.title)}</a>
      <div style="color:#555;font-size:13px">${esc(m.company || "")}${m.company && loc ? " · " : ""}${esc(loc)}${sal ? ` · ${esc(sal)}` : ""}</div>
      ${m.score != null ? `<div style="color:#0a7d2c;font-size:12px">Fit score: ${m.score}/100</div>` : ""}
    </td></tr>`;
  }).join("");

  const resumeBlock = hasResume && resumeScore != null
    ? `<p style="background:#f6fef9;border:1px solid #cde9d4;padding:12px;border-radius:8px">
         <strong>Your resume fit score: ${resumeScore}/100.</strong>
         ${resumeScore < 75
           ? "Here's what's most likely holding your applications back, and how to fix it."
           : "Strong score. Keep it tuned for each role you target."}
         <br><a href="${appUrl}/review" style="color:#1a73e8">See your full breakdown →</a></p>`
    : `<p style="background:#fff8e6;border:1px solid #f0dfae;padding:12px;border-radius:8px">
         <strong>Free resume fit score:</strong> upload your resume once and see
         exactly what's blocking your interviews: the gaps, the missing keywords,
         the fixes. <a href="${appUrl}/review" style="color:#1a73e8">Get your free score →</a></p>`;

  const winbackLine = variant === "winback"
    ? `<p>We noticed you haven't opened our recent matches. Want to keep receiving
       <strong>free</strong> fit-scored matches? <a href="${appUrl}/matches">Update your preferences</a>
       or <a href="${unsubUrl}">unsubscribe</a>. No hard feelings.</p>` : "";

  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222">
    <p>${greeting}</p>
    ${winbackLine}
    <h2 style="font-size:18px">Today's top matches for you</h2>
    <table style="width:100%">${matchRows || `<tr><td>New matches are being scored for your profile. Check back shortly.</td></tr>`}</table>
    ${resumeBlock}
    ${weave ? productWeaveHtml(weave) : ""}
    ${weave ? goSlugLineHtml(goSlugUrl) : ""}
    ${footerHtml(unsubUrl, { stream, address })}
  </body></html>`;

  const text = `${greeting}\n\nToday's top matches:\n` +
    matches.map((m) => `- ${m.title} (${m.company || ""}${m.location ? ", " + m.location : ""}) ${m.score != null ? `[fit ${m.score}/100]` : ""}\n  ${m.url}`).join("\n") +
    (hasResume && resumeScore != null
      ? `\n\nYour resume fit score: ${resumeScore}/100. See your full breakdown: ${appUrl}/review`
      : `\n\nGet your FREE resume fit score. See exactly what's blocking your interviews: ${appUrl}/review`) +
    (weave ? productWeaveText(weave) : "") +
    (weave ? goSlugLineText(goSlugUrl) : "") +
    footerText(unsubUrl, { stream, address });

  return { subject, html, text };
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ── Genius Flow skeletons (template diversity) ──────────────────────
//
// 6 skeletons, picked per recipient per day:
//   skeleton_idx = hashStr(email + "|" + dateStr) % 6
// Winback (2) stays restricted to at-risk bands; everyone else rotates.
// Legacy pending contacts rotate between repermission (3) and
// tool-spotlight (5) only — both are value-first with zero affiliate
// weave, so the ATS Mirror launch doubles as the repermission vehicle.
// Every skeleton: no emojis, max one em dash, short phone-typed sentences,
// never promises interviews/jobs, List-Unsubscribe footer + sender
// disclosure in both html and text.

export const SKELETON = { HOOK_LOCAL: 0, DIGEST: 1, WINBACK: 2, REPERMISSION: 3, VALUE_ONLY: 4, TOOL_SPOTLIGHT: 5 };
export const SKELETON_NAMES = ["hook_local", "digest", "winback", "repermission", "value_only", "tool_spotlight"];

// Deterministic skeleton pick: stable per recipient per day, different
// across the list (no bot-blast fingerprint).
export function skeletonIndexFor(email, dateStr = null) {
  const em = String(email || "").trim().toLowerCase();
  const ds = dateStr || new Date().toISOString().slice(0, 10);
  return hashStr(`${em}|${ds}`) % 6;
}

// Winback is restricted to at-risk bands (and the existing winback
// variant flag), exactly as before — the rotation never sends a winback
// to an engaged or fresh contact: a hash that lands on index 2 for anyone
// else is remapped to the digest anchor.
//
// Legacy pending contacts (the aged re-engagement cohort) rotate between
// repermission and tool-spotlight only. Tool-spotlight promotes our own
// free tools (ATS Mirror et al) with zero affiliate weave, so it carries
// the same value-first, no-sell treatment the standing order requires.
export function resolveSkeleton({ email, band, variant, dateStr = null, source = null }) {
  if (band === "at_risk" || variant === "winback") return SKELETON.WINBACK;
  if (source === "legacy") {
    const idx = skeletonIndexFor(email, dateStr);
    return idx % 2 === 0 ? SKELETON.REPERMISSION : SKELETON.TOOL_SPOTLIGHT;
  }
  const idx = skeletonIndexFor(email, dateStr);
  return idx === SKELETON.WINBACK ? SKELETON.DIGEST : idx;
}

// ── shared footer + product weave ────────────────────────────────────
//
// Stream-aware CAN-SPAM footer. `stream` is "legacy" for the legacy
// re-engagement list (first touch / repermission — honest language that
// never claims the recipient opted in) and "opted_in" (default) for
// everyone who asked for job alerts. Both versions always carry the
// physical mailing address and the one-click unsubscribe.

function footerHtml(unsubUrl, { stream = "opted_in", address = PHYSICAL_ADDRESS_PLACEHOLDER } = {}) {
  const body = stream === "legacy"
    ? `You're receiving this because your address was on a previous list. If you don't want job-market emails, <a href="${unsubUrl}" style="color:#888">unsubscribe here</a> — no hard feelings.`
    : `You're getting this because you asked for free job alerts from mehyar.jobs. <a href="${unsubUrl}" style="color:#888">Unsubscribe</a> anytime with one click.`;
  return `<p style="font-size:12px;color:#888;margin-top:24px">${body}<br>Mehyar Jobs · ${esc(address)}</p>`;
}

function footerText(unsubUrl, { stream = "opted_in", address = PHYSICAL_ADDRESS_PLACEHOLDER } = {}) {
  const body = stream === "legacy"
    ? `You're receiving this because your address was on a previous list.\nIf you don't want job-market emails, unsubscribe here — no hard feelings.\nUnsubscribe: ${unsubUrl}`
    : `You're getting this because you asked for free job alerts from mehyar.jobs.\nUnsubscribe: ${unsubUrl}`;
  return `\n\n${body}\nMehyar Jobs · ${address}`;
}

// One affiliate product per email, woven as a P.S. Only skeletons 0
// (hook-local) and 1 (digest) ever weave; repermission and value-only
// never do. Disclosure: #ad + "affiliate link" + "we may earn a
// commission" adjacent to the link, in BOTH html and text.
// The link goes to our own /gear/<slug> review page — the affiliate
// click happens there (tap-tracked /r/<id> redirect), never to Amazon.
function productWeaveHtml(weave) {
  const lead = weave.angle ? `${esc(weave.name)}: ${esc(weave.angle)}.` : `${esc(weave.name)}.`;
  return `<p style="font-size:13px;color:#555">P.S. ${lead}<br>#ad: <a href="${weave.url}" style="color:#1a73e8">affiliate link</a> (we may earn a commission if you buy through it).</p>`;
}

// Dated campaign-slug link ("today's pick, reviewed") — rendered only
// when a product was woven, so the line never promises a review that
// isn't behind it.
function goSlugLineHtml(goSlugUrl) {
  return goSlugUrl
    ? `<p style="font-size:12px;color:#888">Today's pick, reviewed: <a href="${goSlugUrl}" style="color:#1a73e8">see the full review</a></p>`
    : "";
}

function goSlugLineText(goSlugUrl) {
  return goSlugUrl ? `\n\nToday's pick, reviewed: ${goSlugUrl}` : "";
}

function productWeaveText(weave) {
  const lead = weave.angle ? `${weave.name}: ${weave.angle}.` : `${weave.name}.`;
  return `\n\nP.S. ${lead}\n#ad: affiliate link (we may earn a commission if you buy through it): ${weave.url}`;
}

// ── subject pool: 20 subjects ────────────────────────────────────────
// hook-local x5, digest x5 (digestSubject), winback x2 (digestSubject
// winback variant), repermission x4, value-only x4. Stable per recipient
// per day via hashStr(email|date). No FREE, no all-caps words, no
// exclamation marks. Personal with name only when a real name exists.

function stablePoolPick(email, dateStr, pool) {
  const em = String(email || "").trim().toLowerCase();
  const ds = dateStr || new Date().toISOString().slice(0, 10);
  return pool[hashStr(`${em}|${ds}`) % pool.length];
}

export function hookLocalSubject({ email, firstName, marketData, dateStr = null, extraSubjects = [] }) {
  const name = String(firstName || "").trim();
  const city = String(marketData?.city || "").trim();
  const n = marketData?.postingCount || 0;
  const pct = marketData?.remotePct;
  const band = marketData?.salaryBand;
  const pool = [
    `${city}: ${n} new postings near you this week`,
    name ? `${name}, the ${city} market this week` : `The ${city} market this week`,
    pct != null ? `${pct}% of ${city} postings list remote` : `Remote share in ${city}, this week`,
    band ? `Salary bands near ${city}: ${band}` : `What ${city} postings pay this week`,
    pct != null ? `${n} postings, ${pct}% remote: ${city} this week` : `${n} postings near ${city} this week`,
  ].concat((Array.isArray(extraSubjects) ? extraSubjects : []).map(String).filter(Boolean));
  return stablePoolPick(email, dateStr, pool);
}

export function repermissionSubject({ email, firstName, dateStr = null, extraSubjects = [] }) {
  const name = String(firstName || "").trim();
  const pool = [
    `Still want these job alerts?`,
    name ? `${name}, a quick yes or no` : `A quick yes or no`,
    `Should I keep sending these?`,
    `One tap to stay on the list`,
  ].concat((Array.isArray(extraSubjects) ? extraSubjects : []).map(String).filter(Boolean));
  return stablePoolPick(email, dateStr, pool);
}

export function valueOnlySubject({ email, firstName, dateStr = null, extraSubjects = [] }) {
  const name = String(firstName || "").trim();
  const pool = [
    `The 10-second filter trick for remote roles`,
    `How to spot a ghost listing`,
    `The salary band trick most people miss`,
    name ? `${name}, one tip before your next apply` : `One tip before your next apply`,
  ].concat((Array.isArray(extraSubjects) ? extraSubjects : []).map(String).filter(Boolean));
  return stablePoolPick(email, dateStr, pool);
}

// ── skeleton 0: hook-local ───────────────────────────────────────────
//
// One true local market stat (from getLocalMarket, computed by the
// caller — never invented), one line of meaning, ONE primary CTA, a
// reply ask, then the optional product weave. No-assumption rule: the
// recipient is known only by email + city — never assume their role,
// seniority, industry, or employment status. Falls back to the digest
// skeleton when no location/market data is known.

export function renderHookLocal({ contact, marketData, personalization, weave = null, unsubUrl, appUrl, stream = "opted_in", address = PHYSICAL_ADDRESS_PLACEHOLDER, dateStr = null, extraSubjects = [], goSlugUrl = null }) {
  if (!marketData || !marketData.postingCount) {
    return renderDigestEmail({ contact, personalization, weave, unsubUrl, appUrl, variant: "standard", stream, address, dateStr, extraSubjects, goSlugUrl });
  }
  const name = (contact.firstName || contact.first_name || "").trim();
  const greeting = name ? `Hi ${name},` : "Hi,";
  const { city, postingCount, remotePct, salaryBand } = marketData;
  const subject = hookLocalSubject({ email: contact.email, firstName: name, marketData, dateStr, extraSubjects });

  const statHtml = salaryBand
    ? `${remotePct}% list remote. The middle salary band in the batch: ${esc(salaryBand)}.`
    : `${remotePct}% list remote.`;
  const statText = salaryBand
    ? `${remotePct}% list remote. The middle salary band in the batch: ${salaryBand}.`
    : `${remotePct}% list remote.`;

  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222">
    <p>${greeting}</p>
    <p><strong>${postingCount} postings went up in the ${esc(city)} area this week.</strong></p>
    <p>${statHtml}</p>
    <p>That's the market. Here's what it means for you: the jobs are there. The filter is the resume.</p>
    <p>Run your resume through the free fit check. It scores you against real postings and tells you exactly what's blocking interviews.</p>
    <p><a href="${appUrl}/review" style="color:#1a73e8;font-weight:bold">Get your free score</a></p>
    <p>One question back: what's the biggest thing slowing your search right now? Hit reply. I read every one.</p>
    <p>Mehyar</p>
    ${weave ? productWeaveHtml(weave) : ""}
    ${weave ? goSlugLineHtml(goSlugUrl) : ""}
    ${footerHtml(unsubUrl, { stream, address })}
  </body></html>`;

  const text = `${greeting}\n\n${postingCount} postings went up in the ${city} area this week.\n\n${statText}` +
    `\n\nThat's the market. Here's what it means for you: the jobs are there. The filter is the resume.` +
    `\n\nRun your resume through the free fit check. It scores you against real postings and tells you exactly what's blocking interviews.` +
    `\n\nGet your free score: ${appUrl}/review` +
    `\n\nOne question back: what's the biggest thing slowing your search right now? Hit reply. I read every one.` +
    `\n\nMehyar` +
    (weave ? productWeaveText(weave) : "") +
    (weave ? goSlugLineText(goSlugUrl) : "") +
    footerText(unsubUrl, { stream, address });

  return { subject, html, text };
}

// ── skeleton 3: repermission ─────────────────────────────────────────
//
// For stale/unengaged imports: a plain permission ask. One tap to stay,
// one tap to leave. No matches, no sell, no product weave. One screen on
// mobile.

export function renderRepermission({ contact, unsubUrl, appUrl, stream = "opted_in", address = PHYSICAL_ADDRESS_PLACEHOLDER, dateStr = null, extraSubjects = [] }) {
  const name = (contact.firstName || contact.first_name || "").trim();
  const greeting = name ? `Hi ${name},` : "Hi,";
  const subject = repermissionSubject({ email: contact.email, firstName: name, dateStr, extraSubjects });

  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222">
    <p>${greeting}</p>
    <p><strong>Still want these?</strong></p>
    <p>You're on my free job alerts list from mehyar.jobs. You haven't opened the last few, which is fine. I'd rather send to people who want them.</p>
    <p><a href="${appUrl}/matches" style="color:#1a73e8;font-weight:bold">Keep them coming</a></p>
    <p><a href="${unsubUrl}" style="color:#888">Stop them here</a></p>
    <p>Mehyar</p>
    ${footerHtml(unsubUrl, { stream, address })}
  </body></html>`;

  const text = `${greeting}\n\nStill want these?\n\nYou're on my free job alerts list from mehyar.jobs. You haven't opened the last few, which is fine. I'd rather send to people who want them.` +
    `\n\nKeep them coming: ${appUrl}/matches\nStop them here: ${unsubUrl}\n\nMehyar` +
    footerText(unsubUrl, { stream, address });

  return { subject, html, text };
}

// ── skeleton 4: value-only ───────────────────────────────────────────
//
// Zero sell. One genuinely useful piece of job-search intelligence. The
// reply ask IS the CTA; one plain link to the app, no app-pitch block,
// never a product weave. High replies train the inbox providers.

const VALUE_TIPS = [
  `On mehyar.jobs, filter location to "Remote" and sort by posted date. Then check the posting age before you apply. Anything older than 30 days with 500+ applicants is a ghost listing. Skip it. Your time is worth more than a black hole. The sweet spot: posted in the last 7 days, under 100 applicants. That's where the reply rate lives.`,
  `When a posting shows a salary band like $120k-$150k, the top number is where they expect you to land with competing offers. The bottom is where they hope you'll take it. Apply anyway if you're within reach of the bottom. The band is a starting point, not a verdict.`,
  `Set a "posted in the last 3 days" filter before anything else. Fresh postings get read. Anything older than two weeks usually has a shortlist already, and you're applying into a pile. Recency beats volume.`,
  `One resume per role type beats one resume for everything. Mirror the posting's top 3 keywords in your summary. That's what the ATS scans first, and it's what the hiring manager skims in the first six seconds.`,
  `Tuesday through Thursday mornings are when hiring managers actually open applications. Batch your applies for then instead of Sunday night. Same resume, better timing.`,
  `If a posting lists "unlimited PTO" but no salary band, ask for the band in your first reply. Vague benefits often hide below-market pay. The companies that pay well say the number out loud.`,
];

export function valueTipFor(email, dateStr = null) {
  const em = String(email || "").trim().toLowerCase();
  const ds = dateStr || new Date().toISOString().slice(0, 10);
  return VALUE_TIPS[hashStr(`${em}|${ds}`) % VALUE_TIPS.length];
}

export function renderValueOnly({ contact, tip = null, unsubUrl, appUrl, stream = "opted_in", address = PHYSICAL_ADDRESS_PLACEHOLDER, dateStr = null, extraSubjects = [] }) {
  const name = (contact.firstName || contact.first_name || "").trim();
  const greeting = name ? `Hi ${name},` : "Hi,";
  const body = tip || valueTipFor(contact.email, dateStr);
  const subject = valueOnlySubject({ email: contact.email, firstName: name, dateStr, extraSubjects });

  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222">
    <p>${greeting}</p>
    <p><strong>Quick one. No pitch today.</strong></p>
    <p>${esc(body)}</p>
    <p>Reply and tell me what you're seeing out there. Real data beats guesswork, and I collect both.</p>
    <p><a href="${appUrl}" style="color:#1a73e8">${esc(appUrl)}</a></p>
    <p>Mehyar</p>
    ${footerHtml(unsubUrl, { stream, address })}
  </body></html>`;

  const text = `${greeting}\n\nQuick one. No pitch today.\n\n${body}` +
    `\n\nReply and tell me what you're seeing out there. Real data beats guesswork, and I collect both.` +
    `\n\n${appUrl}\n\nMehyar` +
    footerText(unsubUrl, { stream, address });

  return { subject, html, text };
}

// ── skeleton 5: tool-spotlight ───────────────────────────────────────
//
// One of our own free tools, one email. Zero sell, zero affiliate weave:
// the tool IS the value. This skeleton doubles as the repermission
// vehicle for the legacy cohort ("we built this for you"), so it never
// claims the recipient opted in — the stream-aware footer carries the
// honest language. One primary CTA. No emojis, max one em dash.

export const TOOL_SPOTLIGHTS = [
  {
    id: "ats-mirror",
    path: "/ats-mirror",
    name: "ATS Mirror",
    subjects: [
      "See your resume the way hiring software sees it",
      "I built a tool that reads resumes like a robot",
    ],
    headline: "Your resume, through a robot's eyes.",
    body: "Most resumes get read by software before any human looks at them. The ATS Mirror runs yours through a 9-point check: parseability, keywords, quantified impact — and shows you exactly what the software sees. Then it hands you a rewritten, ATS-safe version. Free, no account needed for your first check.",
    cta: "Mirror my resume",
  },
  {
    id: "resume-studio",
    path: "/studio",
    name: "Resume Studio",
    subjects: [
      "Your resume, tailored to the posting in seconds",
      "One resume per role type beats one for everything",
    ],
    headline: "Stop sending the same resume everywhere.",
    body: "One resume for every application is why applications go nowhere. Paste a posting into the Resume Studio and it rewrites your resume to match the posting's language, then drafts a cover letter to go with it. Free.",
    cta: "Open the Studio",
  },
  {
    id: "ai-review",
    path: "/review",
    name: "AI Resume Review",
    subjects: [
      "What score would your resume get?",
      "A 0-100 score for your resume, with fixes",
    ],
    headline: "A hireability score, with the fixes.",
    body: "Upload your resume and get a 0-100 score with honest strengths, gaps, and exact fixes you can apply today. Takes under a minute. Free.",
    cta: "Score my resume",
  },
  {
    id: "job-alerts",
    path: "/signup",
    name: "Job Alerts",
    subjects: [
      "New jobs that fit you, every morning",
      "The daily drop, matched to your background",
    ],
    headline: "The jobs, before the pile.",
    body: "We scan thousands of public postings every day and email you only the ones that fit your background. Fresh postings get read; the pile gets skipped. Free, and one click stops them anytime.",
    cta: "Get my alerts",
  },
];

export function toolSpotlightFor(email, dateStr = null) {
  const em = String(email || "").trim().toLowerCase();
  const ds = dateStr || new Date().toISOString().slice(0, 10);
  return TOOL_SPOTLIGHTS[hashStr(`${em}|${ds}`) % TOOL_SPOTLIGHTS.length];
}

export function toolSpotlightSubject({ email, firstName, tool, dateStr = null, extraSubjects = [] }) {
  const pool = (tool?.subjects || []).concat(
    (Array.isArray(extraSubjects) ? extraSubjects : []).map(String).filter(Boolean)
  );
  return stablePoolPick(email, dateStr, pool.length ? pool : ["Something useful I built for you"]);
}

export function renderToolSpotlight({ contact, tool = null, unsubUrl, appUrl, stream = "opted_in", address = PHYSICAL_ADDRESS_PLACEHOLDER, dateStr = null, extraSubjects = [] }) {
  const name = (contact.firstName || contact.first_name || "").trim();
  const greeting = name ? `Hi ${name},` : "Hi,";
  const t = tool || toolSpotlightFor(contact.email, dateStr);
  const toolUrl = `${appUrl}${t.path}`;
  const subject = toolSpotlightSubject({ email: contact.email, firstName: name, tool: t, dateStr, extraSubjects });

  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222">
    <p>${greeting}</p>
    <p><strong>${esc(t.headline)}</strong></p>
    <p>${esc(t.body)}</p>
    <p><a href="${toolUrl}" style="color:#1a73e8;font-weight:bold">${esc(t.cta)} →</a></p>
    <p>Mehyar</p>
    ${footerHtml(unsubUrl, { stream, address })}
  </body></html>`;

  const text = `${greeting}\n\n${t.headline}\n\n${t.body}\n\n${t.cta}: ${toolUrl}\n\nMehyar` +
    footerText(unsubUrl, { stream, address });

  return { subject, html, text, tool: t.id };
}

// Central skeleton dispatcher: renders the right skeleton for the
// recipient. `weave` is the product-of-the-day weave ({ slug, name, url,
// angle }) or null — only skeletons 0 and 1 ever receive it. `url` is the
// /gear/<slug> review page — campaign emails link there, NEVER directly
// to Amazon; the affiliate click happens on our page.
export function renderForSkeleton({ skeleton, contact, personalization, marketData = null, weave = null, unsubUrl, appUrl, stream = "opted_in", address = PHYSICAL_ADDRESS_PLACEHOLDER, dateStr = null, extraSubjects = [], goSlugUrl = null }) {
  switch (skeleton) {
    case SKELETON.HOOK_LOCAL:
      return renderHookLocal({ contact, marketData, personalization, weave, unsubUrl, appUrl, stream, address, dateStr, extraSubjects, goSlugUrl });

    case SKELETON.WINBACK:
      return renderDigestEmail({ contact, personalization, unsubUrl, appUrl, variant: "winback", stream, address, dateStr, extraSubjects });
    case SKELETON.REPERMISSION:
      return renderRepermission({ contact, unsubUrl, appUrl, stream, address, dateStr, extraSubjects });
    case SKELETON.VALUE_ONLY:
      return renderValueOnly({ contact, unsubUrl, appUrl, stream, address, dateStr, extraSubjects });
    case SKELETON.TOOL_SPOTLIGHT:
      return renderToolSpotlight({ contact, unsubUrl, appUrl, stream, address, dateStr, extraSubjects });
    case SKELETON.DIGEST:
    default:
      return renderDigestEmail({ contact, personalization, weave, unsubUrl, appUrl, variant: "standard", stream, address, dateStr, extraSubjects, goSlugUrl });
  }
}

// ── local market data (§4 query shapes) ──────────────────────────────
//
// The only allowed number sources for skeleton 0: counts, remote share,
// and salary-band medians over active postings from the last 7 days,
// filtered by city. Returns null when nothing is known (the caller
// falls back to the digest skeleton). Numbers are computed at send
// time, never hard-coded.

function fmtK(n) {
  return n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`;
}

export async function getLocalMarket(db, city) {
  const c = String(city || "").trim();
  if (!c) return null;
  let row = null;
  try {
    row = await db.prepare(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN remote_policy = 'remote' THEN 1 ELSE 0 END) AS remote_n
       FROM job
       WHERE is_active = 1 AND location LIKE ? AND posted_at >= date('now','-7 days')`
    ).bind(`%${c}%`).first();
  } catch { return null; }
  const n = row?.n || 0;
  if (!n) return null;
  const remotePct = Math.round(((row.remote_n || 0) * 100) / n);

  let salaryBand = null;
  try {
    const srows = await db.prepare(
      `SELECT salary_min, salary_max FROM job
       WHERE is_active = 1 AND location LIKE ? AND posted_at >= date('now','-7 days')
         AND salary_min IS NOT NULL AND salary_max IS NOT NULL
       ORDER BY id LIMIT 5000`
    ).bind(`%${c}%`).all().then((r) => r.results || []);
    const mins = srows.map((r) => r.salary_min).sort((a, b) => a - b);
    const maxs = srows.map((r) => r.salary_max).sort((a, b) => a - b);
    if (mins.length) {
      const med = (a) => a[Math.floor(a.length / 2)];
      salaryBand = `${fmtK(med(mins))}–${fmtK(med(maxs))}`;
    }
  } catch { /* band stays null — the stat line just omits it */ }

  return { city: c, postingCount: n, remotePct, salaryBand };
}

// ── ESP abstraction ──────────────────────────────────────────────────
// provider: 'smtp2go' (aged cohorts) | 'brevo' (warm/fresh segments).
// Dry-run unless { live: true } AND env.EMAIL_LIVE === '1'.

export function espForContact(contact) {
  return contact.source === "legacy" ? "smtp2go" : "brevo";
}

export function fromAddressFor(env, provider) {
  if (provider === "smtp2go") return env.AGED_FROM_EMAIL || "jobs@mail.mehyar.us";
  return env.FRESH_FROM_EMAIL || "jobs@updates.mehyar.us";
}

export async function sendEmailViaEsp(env, { to, subject, html, text, provider, fromEmail }) {
  const live = env.EMAIL_LIVE === "1";
  const from = fromEmail || fromAddressFor(env, provider);
  if (!live) return { ok: true, dryRun: true, provider };

  try {
    if (provider === "smtp2go") {
      const key = env.SMTP2GO_API_KEY;
      if (!key) throw new Error("SMTP2GO_API_KEY not configured");
      const r = await fetch("https://api.smtp2go.com/v3/email/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: key, to: [to], sender: from, subject, html_body: html, text_body: text }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.data?.error) throw new Error(j?.data?.error || `smtp2go http ${r.status}`);
      return { ok: true, provider, id: j?.data?.email_id || null };
    }
    // brevo
    const key = env.BREVO_API_KEY;
    if (!key) throw new Error("BREVO_API_KEY not configured");
    const r = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "content-type": "application/json", "api-key": key },
      body: JSON.stringify({ sender: { email: from }, to: [{ email: to }], subject, htmlContent: html, textContent: text }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.message || `brevo http ${r.status}`);
    return { ok: true, provider, id: j?.messageId || null };
  } catch (e) {
    return { ok: false, provider, error: String(e?.message || e) };
  }
}

// ── daily queue ──────────────────────────────────────────────────────

export async function logEmailSend(db, { contactId, kind, template, variant, subject, providerUsed, status, error = null, meta = {} }) {
  const now = new Date().toISOString();
  let metaJson = "{}";
  try { metaJson = JSON.stringify(meta || {}); } catch { /* keep '{}' */ }
  await db.prepare(
    `INSERT INTO email_send (contact_id, kind, template, variant, subject, provider_used, status, sent_at, error, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(contactId, kind, template, variant, subject, providerUsed, status, status === "sent" ? now : null, error, metaJson).run();
}

async function markSent(db, contact, now) {
  const today = dayStr(now);
  await db.prepare(
    `UPDATE email_contact SET sent_count = sent_count + 1, last_sent_at = ?,
       week_sent_count = week_sent_count + 1, status = CASE WHEN status = 'pending' THEN 'active' ELSE status END
     WHERE id = ?`
  ).bind(now.toISOString(), contact.contactId).run();
  await ensureEngagementRow(db, contact.contactId);
  await db.prepare(
    "UPDATE contact_engagement SET sends_since_engagement = sends_since_engagement + 1, updated_at = ? WHERE contact_id = ?"
  ).bind(now.toISOString(), contact.contactId).run();
  void today;
}

// ── daily campaign weave (Worker 6) ──────────────────────────────────
// Resolves the product of the day (plan override or deterministic
// catalog rotation) and builds the /gear/<slug> review-page weave URL.
// Exported for tests and the daily review tooling. Lazy import avoids a
// hard module cycle (campaignPlan imports hashStr from this module).
export async function buildWeaveForSend(db, todayStr, appUrl, plan) {
  let weave = null;
  let weaveProductId = null; // plan path: stamp last_featured_on only after sends
  try {
    const { getProductOfDay, productAngles } = await import("./productCatalog.js");
    let pod = null;
    if (plan && plan.product) {
      pod = plan.product;
    } else {
      pod = await getProductOfDay(db, todayStr, { markFeatured: true });
    }
    if (pod && pod.url && pod.active === 1 && pod.approved === 1) {
      const angles = productAngles(pod);
      weave = {
        slug: pod.slug,
        name: pod.name,
        url: `${String(appUrl || "https://jobs.mehyar.us").replace(/\/+$/, "")}/gear/${pod.slug}`,
        angle: angles.length ? angles[hashStr(`${pod.slug}|${todayStr}`) % angles.length] : "",
      };
      if (plan && plan.product) weaveProductId = pod.id;
    }
  } catch { /* no product woven today — the send goes out clean */ }
  return { weave, weaveProductId };
}

// Build the list, pick each recipient's skeleton, render, and send (or
// dry-run). Returns a summary.
//
// Skeleton dispatch: at-risk bands get the winback variant only; legacy
// pending contacts rotate between repermission and tool-spotlight;
// everyone else rotates across the 6 skeletons via hashStr(email|date) % 6.
// Product weave: at most ONE product per email, only on the hook-local and
// digest skeletons (repermission, value-only, and tool-spotlight never
// weave), only when the product of the day is active=1 AND approved=1 with
// a real URL. The send is recorded with meta_json.product +
// meta_json.go_slug (and meta_json.tool for tool-spotlight) so
// product-tagged events aggregate in the campaign report and opens/clicks
// attribute to the day's dated campaign slug.
export async function queueDailySends(db, env, { live = false, kind = "warmup", template = "daily_digest", now = new Date(), appUrl = "https://jobs.mehyar.us", signUnsub = null } = {}) {
  const gateCheck = await preSendGateCheck(db, template);
  if (!gateCheck.ok) return { ok: false, blocked: "seed_test", reason: gateCheck.reason };

  const { list, cap, gate, counts, blocked } = await buildDailyList(db, { now, env });
  if (blocked) return { ok: false, blocked, cap };

  const todayStr = dayStr(now);

  // ── Campaign plan (brain) ─────────────────────────────────────────
  // Today's plan row (written by the 06:30 ET brain cron): template mix,
  // product-of-day override, subject tweaks, segment focus. No row (or an
  // invalid one) -> the deterministic behavior below, unchanged.
  // Lazy import avoids a hard module cycle (campaignPlan imports hashStr
  // from this module).
  let plan = null;
  try {
    const { resolvePlanForSend } = await import("./campaignPlan.js");
    plan = await resolvePlanForSend(db, todayStr);
  } catch { plan = null; }

  // Segment focus: stable reorder of the send list when the plan says so.
  let sendList = list;
  if (plan) {
    try {
      const { applySegmentFocus } = await import("./campaignPlan.js");
      sendList = applySegmentFocus(list, plan.segmentFocus);
    } catch { /* keep buildDailyList order */ }
  }

  // One product per day for the whole run. With a plan, the product is the
  // brain's server-validated pick (active + approved + cooldown enforced
  // at plan time); without one, the deterministic catalog rotation. The
  // weave links to our own /gear/<slug> review page (never directly to Amazon).
  const { weave, weaveProductId } = await buildWeaveForSend(db, todayStr, appUrl, plan);

  // Dated campaign slug for the day: one idempotent row per date carrying
  // the day's campaign context (template focus + product of the day).
  // Campaign emails link to it via goSlugUrl, and open/click attribution
  // is recorded against it. Best-effort — never blocks sends.
  let daySlug = null;
  try {
    const { getOrCreateDaySlug } = await import("./landing.js");
    daySlug = await getOrCreateDaySlug(db, todayStr, {
      template: plan && plan.segmentFocus ? `plan:${plan.segmentFocus}` : "rotation",
      product_slug: weave?.slug || null,
      product_angle: weave?.angle || null,
    });
  } catch { /* attribution slug is best-effort */ }
  const goSlugUrl = daySlug ? `${String(appUrl || "https://jobs.mehyar.us").replace(/\/+$/, "")}/go/${daySlug.slug}` : null;

  // Subject tweaks from the plan, per skeleton id.
  const tweaksFor = (skelId) => plan
    ? plan.subjectTweaks.filter((t) => Number(t.skeleton_id) === skelId).map((t) => String(t.subject))
    : [];

  // Skeleton pick: the plan's weight mix when a plan exists, otherwise the
  // uniform deterministic rotation. The winback guardrail holds in both
  // paths: winback is only ever sent to at-risk contacts. Legacy pending
  // contacts (the aged cohort) always get repermission/value-first
  // treatment — they rotate between repermission and tool-spotlight only,
  // regardless of the LLM's weight mix.
  let pickSkeleton = null;
  if (plan) {
    try {
      const { chooseSkeletonIdx } = await import("./campaignPlan.js");
      pickSkeleton = (c) => {
        if (c.band === "at_risk" || c.variant === "winback") return SKELETON.WINBACK;
        if (c.source === "legacy") return resolveSkeleton({ email: c.email, dateStr: todayStr, source: "legacy" });
        const idx = chooseSkeletonIdx(plan.skeletonWeights, c.email, todayStr);
        return idx === SKELETON.WINBACK ? SKELETON.DIGEST : idx;
      };
    } catch { pickSkeleton = null; }
  }
  if (!pickSkeleton) {
    pickSkeleton = (c) => resolveSkeleton({ email: c.email, band: c.band, variant: c.variant, dateStr: todayStr, source: c.source });
  }

  const results = { attempted: 0, sent: 0, dryRun: 0, failed: 0, errors: [] };
  for (const c of sendList) {
    const personalization = await personalizeForContact(db, c);
    let unsubUrl = `${appUrl}/unsubscribe`;
    try {
      if (signUnsub) unsubUrl = `${appUrl}/unsubscribe?token=${await signUnsub(c.email, env)}`;
    } catch { /* fall back to plain link */ }

    let skel = pickSkeleton(c);
    let marketData = null;
    if (skel === SKELETON.HOOK_LOCAL) {
      marketData = await getLocalMarket(db, c.city || c.state).catch(() => null);
      if (!marketData) skel = SKELETON.DIGEST; // no local data -> digest fallback
    }
    const skelWeave = (skel === SKELETON.HOOK_LOCAL || skel === SKELETON.DIGEST) ? weave : null;
    // CAN-SPAM stream: legacy re-engagement contacts get honest footer
    // copy (never claims they opted in); everyone else gets the opted-in
    // copy. The physical address resolves from env (see physicalAddress).
    const stream = c.source === "legacy" ? "legacy" : "opted_in";
    const rendered = renderForSkeleton({
      skeleton: skel, contact: c, personalization, marketData,
      weave: skelWeave, unsubUrl, appUrl, stream, address: physicalAddress(env),
      dateStr: todayStr,
      extraSubjects: tweaksFor(skel),
      goSlugUrl,
    });
    const provider = espForContact(c);
    const res = live
      ? await sendEmailViaEsp(env, { to: c.email, subject: rendered.subject, html: rendered.html, text: rendered.text, provider })
      : { ok: true, dryRun: true, provider };
    const status = res.dryRun ? "dry_run" : res.ok ? "sent" : "failed";
    await logEmailSend(db, {
      contactId: c.contactId, kind: skel === SKELETON.WINBACK ? "winback" : kind,
      template: skel === SKELETON.DIGEST ? template : SKELETON_NAMES[skel],
      variant: c.variant, subject: rendered.subject,
      providerUsed: res.dryRun ? "dry_run" : provider, status,
      error: res.error || null,
      meta: { skeleton: SKELETON_NAMES[skel], stream, ...(skelWeave ? { product: skelWeave.slug } : {}), ...(daySlug ? { go_slug: daySlug.slug } : {}), ...(plan ? { plan: 1 } : {}), ...(rendered.tool ? { tool: rendered.tool } : {}) },
    });
    await markSent(db, c, now);
    results.attempted++;
    if (status === "sent") results.sent++;
    else if (status === "dry_run") results.dryRun++;
    else { results.failed++; if (results.errors.length < 5) results.errors.push(`${c.email}: ${res.error}`); }
  }
  // Plan path: stamp the featured product only once it actually went out.
  if (weave && weaveProductId && results.attempted > 0) {
    await db.prepare("UPDATE product_slot SET last_featured_on = ? WHERE id = ?")
      .bind(todayStr, weaveProductId).run().catch(() => {});
  }
  return {
    ok: true, cap, gate: { level: gate.level, status: gate.status }, counts, results,
    plan: plan
      ? { date: todayStr, segment_focus: plan.segmentFocus, product_slug: weave ? weave.slug : null, model: plan.row.model }
      : null,
  };
}

// ── legacy import ────────────────────────────────────────────────────

export async function importEmailContacts(db, contacts) {
  let inserted = 0, skipped = 0;
  for (const c of contacts || []) {
    const email = String(c.email || "").trim().toLowerCase();
    if (!isValidEmail(email)) { skipped++; continue; }
    try {
      await db.prepare(
        `INSERT INTO email_contact (email, status, source, first_name, last_name, city, state, role_title, provider, imported_at)
         VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(email) DO NOTHING`
      ).bind(
        email, c.source || "legacy", c.firstName || null, c.lastName || null,
        c.city || null, c.state || null, c.roleTitle || null, providerOf(email),
        c.importedAt || new Date().toISOString()
      ).run();
      inserted++;
    } catch { skipped++; }
  }
  return { inserted, skipped };
}
