// scripts/email-daily-review.mjs
//
// Daily email-campaign review: the "modify the campaign every day based on
// progress and performance" loop.
//
// 1. Pulls yesterday's (ET) provider stats from SMTP2GO (stats/email_history):
//    sends, bounce %, spam/complaint %, unsubscribe %.
// 2. Reads the current fib_gate state + yesterday's D1 send/event counts.
// 3. Applies the SAME decision logic as evaluateGate() in
//    functions/_shared/emailFunnel.js (thresholds live there; mirror them here):
//      critical (complaint>=0.30 | bounce>=5)            -> PAUSED
//      green    (complaint<0.10 | bounce<2)              -> ADVANCE one fib level
//      otherwise                                         -> HOLD 3 days
//    Postmaster reputation and blocklist hits are manual inputs (null/0 here)
//    and should be folded in via the admin gate endpoint when measured.
// 4. --live writes the decision to fib_gate (same columns evaluateGate writes).
//    Default is --dry-run: reads only, prints the decision.
// 5. Writes a dated brief to email-reviews/YYYY-MM-DD.md for the morning war room.
//
// Usage:
//   node scripts/email-daily-review.mjs [--date YYYY-MM-DD] [--dry-run|--live]
//
// Cron: daily 07:00 ET, --live, so today's cohort selection (fib cap + offer
// rotation) runs on yesterday's real performance.

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Mirrors GATE in functions/_shared/emailFunnel.js — keep in sync.
const COMPLAINT_PCT_MAX = 0.10, BOUNCE_PCT_MAX = 2;
const COMPLAINT_PCT_PAUSE = 0.30, BOUNCE_PCT_PAUSE = 5;
const HOLD_DAYS = 3, ADVANCE_HOLD_DAYS = 2;
const FIB_LEVELS = (() => { const o = [5, 10]; while (o.length < 30) o.push(o[o.length-1] + o[o.length-2]); return o; })();

const SMTP2GO = "python3 /home/hatch/workspace/skills/smtp2go/bin/smtp2go.py";
const WR = "python3 /home/hatch/workspace/skills/cloudflare/bin/wr.py";
const D1 = `${WR} d1 execute mehyar-jobs --remote --config scanner-worker/wrangler.toml`;
const REVIEWS = resolve("email-reviews");

const args = process.argv.slice(2);
const live = args.includes("--live");
const dateArg = (args.find(a => a.startsWith("--date=")) || "").slice(7) || null;

// Yesterday in America/New_York.
function etDay(offsetDays = 1) {
  const now = new Date(Date.now() - offsetDays * 86400000);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return parts; // YYYY-MM-DD
}
const day = dateArg || etDay(1);

// ET day boundaries -> UTC "YYYY-MM-DD HH:MM:SS" for the SMTP2GO API.
function etBounds(ymd) {
  const startEt = new Date(`${ymd}T00:00:00`);
  const endEt = new Date(`${ymd}T23:59:59`);
  // Find the ET offset by round-tripping through the formatter.
  const offsetMin = (d) => {
    const tz = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d);
    const asUtc = new Date(tz.replace(/(\d+)\/(\d+)\/(\d+),? (\d+):(\d+)/, "$3-$1-$2T$4:$5:00"));
    return Math.round((asUtc - d) / 60000);
  };
  const fmt = (d) => d.toISOString().slice(0, 19).replace("T", " ");
  return { start: fmt(new Date(startEt.getTime() - offsetMin(startEt) * 60000)), end: fmt(new Date(endEt.getTime() - offsetMin(endEt) * 60000)) };
}

function sh(cmd, env = {}) {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "621600637337cc1c9ecb7095508bc732", ...env } });
}
function d1json(sql) {
  const out = sh(`${D1} --command ${JSON.stringify(sql)} --json`);
  const parsed = JSON.parse(out);
  const res = Array.isArray(parsed) ? parsed[0] : parsed;
  return res?.results ?? [];
}

// ── 1. Provider stats ────────────────────────────────────────────────
const { start, end } = etBounds(day);
let provider = { sends: 0, bouncePct: 0, complaintPct: 0, unsubPct: 0, note: "" };
try {
  const raw = sh(`${SMTP2GO} call stats/email_history ${JSON.stringify(JSON.stringify({ start_date: start, end_date: end }))}`);
  const data = JSON.parse(raw)?.envelope?.data || {};
  provider = {
    sends: data.count ?? 0,
    bouncePct: data.bounce_percent_total ?? 0,
    complaintPct: data.spam_percent_total ?? 0,
    unsubPct: data.unsubscribe_percent_total ?? 0,
    note: "",
  };
} catch (e) {
  provider.note = `smtp2go stats unavailable: ${String(e.message).slice(0, 120)}`;
}

// ── 2. D1 state ──────────────────────────────────────────────────────
const gateRows = d1json("SELECT * FROM fib_gate WHERE id = 1");
const gate = gateRows[0] || { level_idx: 0, level: 5, status: "ramping", hold_until: null };
const sendRows = d1json(`SELECT status, COUNT(*) c FROM email_send WHERE date(sent_at) = '${day}' OR date(created_at) = '${day}' GROUP BY status`);
const eventRows = d1json(`SELECT kind, COUNT(*) c FROM email_event WHERE date(created_at) = '${day}' GROUP BY kind`);
const offerRows = d1json(`SELECT json_extract(meta_json, '$.offer') AS offer, SUM(kind='click') clicks, SUM(kind='open') opens FROM email_event WHERE date(created_at) = '${day}' AND json_extract(meta_json, '$.offer') IS NOT NULL GROUP BY offer`);

// ── 3. Decision (mirrors evaluateGate) ───────────────────────────────
const now = new Date();
const ts = now.toISOString();
let decision, reason;
const holdActive = gate.hold_until && new Date(gate.hold_until).getTime() > now.getTime() && gate.status !== "paused";
if (holdActive) {
  decision = "holding"; reason = `hold_until ${gate.hold_until} not reached`;
} else if (provider.sends === 0) {
  decision = "holding"; reason = "no sends yesterday — nothing to evaluate, level unchanged";
} else if (provider.complaintPct >= COMPLAINT_PCT_PAUSE || provider.bouncePct >= BOUNCE_PCT_PAUSE) {
  decision = "paused"; reason = `CRITICAL: complaint=${provider.complaintPct}% bounce=${provider.bouncePct}%`;
} else if (provider.complaintPct < COMPLAINT_PCT_MAX && provider.bouncePct < BOUNCE_PCT_MAX) {
  decision = "advanced";
  const nextIdx = Math.min((gate.level_idx ?? 0) + 1, FIB_LEVELS.length - 1);
  reason = `metrics green -> ${FIB_LEVELS[nextIdx]}/day`;
  gate._next = { level_idx: nextIdx, level: FIB_LEVELS[nextIdx] };
} else {
  decision = "holding"; reason = `metrics not green: complaint=${provider.complaintPct}% bounce=${provider.bouncePct}%`;
}

// ── 4. Write (live only) ─────────────────────────────────────────────
let wrote = false;
if (live && !holdActive && provider.sends > 0) {
  const addDays = (d, n) => new Date(new Date(d).getTime() + n * 86400000).toISOString();
  let patch;
  if (decision === "paused") patch = { status: "paused", hold_until: null };
  else if (decision === "advanced") patch = { status: "ramping", hold_until: addDays(ts, ADVANCE_HOLD_DAYS), ...gate._next };
  else patch = { status: "holding", hold_until: addDays(ts, HOLD_DAYS) };
  d1json(`UPDATE fib_gate SET level_idx = ${patch.level_idx ?? gate.level_idx}, level = ${patch.level ?? gate.level}, status = '${patch.status}', hold_until = ${patch.hold_until ? `'${patch.hold_until}'` : "NULL"}, last_complaint_pct = ${provider.complaintPct}, last_bounce_pct = ${provider.bouncePct}, last_evaluated_at = '${ts}', notes = 'daily-review ${day}: ${decision} — ${reason}' WHERE id = 1`);
  wrote = true;
}

// ── 5. Brief ─────────────────────────────────────────────────────────
const brief = [
  `# Email daily review — ${day}`,
  ``,
  `- Provider sends: **${provider.sends}** | bounce **${provider.bouncePct}%** | complaint **${provider.complaintPct}%** | unsub **${provider.unsubPct}%**${provider.note ? ` (${provider.note})` : ""}`,
  `- Fib gate before: level_idx=${gate.level_idx} level=${gate.level}/day status=${gate.status} hold_until=${gate.hold_until || "—"}`,
  `- Decision: **${decision.toUpperCase()}** — ${reason}${live ? (wrote ? " (written to fib_gate)" : "") : " (dry-run, nothing written)"}`,
  `- D1 sends: ${sendRows.map(r => `${r.status}=${r.c}`).join(", ") || "none"}`,
  `- D1 events: ${eventRows.map(r => `${r.kind}=${r.c}`).join(", ") || "none"}`,
  offerRows.length ? `- Offer CTR: ${offerRows.map(r => `${r.offer}: ${r.clicks} clicks / ${r.opens} opens`).join("; ")}` : `- Offer CTR: no offer-tagged events yet (offer rotation dormant until offers launch)`,
  ``,
  `_Manual inputs not covered here: Postmaster reputation, blocklist hits, seed placement — fold in via the admin gate endpoint when measured._`,
  ``,
].join("\n");
mkdirSync(REVIEWS, { recursive: true });
writeFileSync(`${REVIEWS}/${day}.md`, brief);

console.log(JSON.stringify({ ok: true, day, provider, decision, reason, wrote, live, brief_path: `${REVIEWS}/${day}.md` }, null, 2));
