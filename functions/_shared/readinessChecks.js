// _shared/readinessChecks.js
//
// Readiness checks for the email growth engine. Shared by:
//   - functions/api/admin/email/wire-up.js (dashboard, legacy admin path)
//   - functions/api/agent/email/control.js (chat control plane)
//
// runReadinessChecks(db, env) returns { checks: Check[], armed: boolean }.
// When every check passes, the caller may stamp system_flag.sender_armed.

import { FIB_LEVELS, GATE } from "./emailFunnel.js";
import { setSystemFlag } from "./productCatalog.js";

/**
 * @typedef {object} Check
 * @property {string} key
 * @property {string} label
 * @property {boolean} ok
 * @property {string} detail
 */

/** fetch with a 10s timeout. Throws on timeout/network error. */
async function fetchTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function checkSmtp2go(env) {
  const key = env.SMTP2GO_API_KEY || "";
  if (!key) return fail("smtp2go_api", "SMTP2GO_API_KEY missing");
  try {
    const r = await fetchTimeout("https://api.smtp2go.com/v3/stats/email_cycle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: key }),
    });
    const j = await r.json().catch(() => ({}));
    const cycleMax = j?.data?.cycle_max;
    if (r.ok && typeof cycleMax === "number" && cycleMax > 0) {
      return { key: "smtp2go_api", label: "SMTP2GO API", ok: true, detail: `cycle_max=${cycleMax}` };
    }
    return fail("smtp2go_api", `smtp2go http ${r.status} / cycle_max=${cycleMax ?? "?"}`);
  } catch (e) {
    return fail("smtp2go_api", String(e?.message || e));
  }
}

async function checkBrevo(env) {
  const key = env.BREVO_API_KEY || "";
  if (!key) return fail("brevo_api", "BREVO_API_KEY missing");
  try {
    const r = await fetchTimeout("https://api.brevo.com/v3/account", {
      headers: { "api-key": key },
    });
    if (r.ok) {
      const j = await r.json().catch(() => ({}));
      const plan = j?.plan?.[0]?.type || j?.planType || "ok";
      return { key: "brevo_api", label: "Brevo API", ok: true, detail: `account 200, plan=${plan}` };
    }
    return fail("brevo_api", `brevo http ${r.status}`);
  } catch (e) {
    return fail("brevo_api", String(e?.message || e));
  }
}

async function checkFibGate(db) {
  const g = await db.prepare("SELECT * FROM fib_gate WHERE id = 1").first().catch(() => null);
  if (!g) return fail("fib_gate", "fib_gate row missing");
  const levelOk = FIB_LEVELS.includes(g.level);
  const statusOk = ["ramping", "holding", "paused", "complete"].includes(g.status);
  if (!levelOk) return fail("fib_gate", `level ${g.level} not in FIB_LEVELS`);
  if (!statusOk) return fail("unknown status", `unknown status '${g.status}'`);
  return { key: "fib_gate", label: "Fibonacci gate", ok: true, detail: `level=${g.level} (${g.status})` };
}

async function checkSeedTest(db) {
  const latest = await db.prepare(
    "SELECT inbox_pct, spam_pct, tested_at FROM seed_test WHERE template = 'daily_digest' ORDER BY id DESC LIMIT 1"
  ).first().catch(() => null);
  if (!latest) return fail("seed_test", "no seed test on record for template 'daily_digest'");
  const ok = latest.inbox_pct >= GATE.SEED_INBOX_MIN && latest.spam_pct <= GATE.SEED_SPAM_MAX;
  const detail = `inbox=${latest.inbox_pct}% (>=${GATE.SEED_INBOX_MIN}), spam=${latest.spam_pct}% (<=${GATE.SEED_SPAM_MAX})`;
  return { key: "seed_test", label: "Seed test (daily_digest)", ok, detail };
}

async function checkSuppression(db) {
  const rows = await db.prepare(
    "SELECT status, COUNT(*) AS n FROM email_contact GROUP BY status"
  ).all().then((r) => r.results || []);
  const counts = {};
  let total = 0;
  for (const r of rows) { counts[r.status] = r.n; total += r.n; }
  return {
    key: "suppression", label: "Suppression tables", ok: true,
    detail: `contacts=${total} ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
  };
}

async function checkProductCatalog(db) {
  const r = await db.prepare(
    "SELECT COUNT(*) AS n FROM product_slot WHERE active = 1 AND approved = 1"
  ).first().catch(() => null);
  const n = r?.n || 0;
  return { key: "product_catalog", label: "Product catalog", ok: n >= 1, detail: `${n} active+approved products` };
}

async function checkCohort(db) {
  const rows = await db.prepare(
    "SELECT source, COUNT(*) AS n FROM email_contact GROUP BY source"
  ).all().then((r) => r.results || []);
  const total = rows.reduce((s, r) => s + r.n, 0);
  const detail = total > 0
    ? rows.map((r) => `${r.source}=${r.n}`).join(", ")
    : "email_contact is empty — import a cohort first";
  return { key: "cohort", label: "Recipient cohort", ok: total > 0, detail };
}

// Live switch is REPORTED, not gated. Chat is the control plane; the live
// state is Mayor's standing decision, visible here for the record.
function checkEnvLive(env) {
  const v = env.EMAIL_LIVE || "";
  return {
    key: "env_live", label: "Live switch", ok: true,
    detail: v === "1" ? "ON — sending permitted" : "OFF — sends are dry-run",
  };
}

/** @returns {Check} */
function fail(key, detail) {
  const labels = {
    smtp2go_api: "SMTP2GO API", brevo_api: "Brevo API", fib_gate: "Fibonacci gate",
    seed_test: "Seed test (daily_digest)", suppression: "Suppression tables",
    product_catalog: "Product catalog", cohort: "Recipient cohort", env_live: "Live switch",
  };
  return { key, label: labels[key] || key, ok: false, detail };
}

export async function runReadinessChecks(db, env) {
  const checks = await Promise.all([
    checkSmtp2go(env),
    checkBrevo(env),
    checkFibGate(db),
    checkSeedTest(db),
    checkSuppression(db),
    checkProductCatalog(db),
    checkCohort(db),
  ]);
  checks.push(checkEnvLive(env));
  return { checks, armed: checks.every((c) => c.ok) };
}

export async function armSender(db) {
  const armedAt = new Date().toISOString();
  await setSystemFlag(db, "sender_armed", armedAt);
  return armedAt;
}
