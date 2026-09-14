// scripts/test-user-digests.mjs
// Tests the per-user digest fan-out (scanner-worker/src/userDigests.js):
// newsletter subscribers get their own matches emailed; the log makes
// retries idempotent; the owner is excluded (he gets the admin digest).
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureSchema } from "../functions/_shared/db.js";
import { deliverUserDigests } from "../scanner-worker/src/userDigests.js";
import { deliverDailyDigest, deliverOldestCompletedDigest } from "../scanner-worker/src/dailyDigest.js";
import { deriveProfileFromResume } from "../functions/_shared/userAuth.js";

class D1Shim {
  constructor() { this.db = new DatabaseSync(":memory:"); this.stmts = []; }
  prepare(sql) {
    const stmt = this.db.prepare(sql);
    this.stmts.push(stmt);
    const wrap = (params) => ({
      first: async () => stmt.get(...params) ?? null,
      all: async () => ({ results: stmt.all(...params) }),
      run: async () => {
        const r = stmt.run(...params);
        return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
      },
    });
    return { bind: (...p) => wrap(p), first: () => wrap([]).first(), all: () => wrap([]).all(), run: () => wrap([]).run() };
  }
  async batch(list) { const out = []; for (const s of list) out.push(await s.run()); return out; }
}

const sent = [];
const env = {
  JOBS_DB: new D1Shim(),
  ADMIN_SESSION_SECRET: "digest-test-secret",
  MEHYARSOFT_ADMIN_USERNAME: "Mehyar500",
  NOTIFY_EMAIL: "mrswelim@gmail.com",
  JOBS_APP_URL: "https://jobs.mehyar.us",
  DIGEST_FROM_EMAIL: "noreply@mehyar.us",
  EMAIL: { send: async (msg) => { sent.push(msg); return { id: `msg-${sent.length}` }; } },
};

const scanDay = "2026-09-13";
await ensureSchema(env);
const db = env.JOBS_DB;

async function addUser({ email, name, resume, newsletter, admin }) {
  const r = await db.prepare(
    "INSERT INTO app_user (username, email, display_name, password_hash, newsletter_opt_in, is_admin) VALUES (?, ?, ?, 'pbkdf2-sha256$x', ?, ?)"
  ).bind(email.split("@")[0], email, name, newsletter ? 1 : 0, admin ? 1 : 0).run();
  const id = r.meta.last_row_id;
  if (resume) {
    await db.prepare("INSERT INTO user_resume (user_id, text, is_active) VALUES (?, ?, 1)").bind(id, resume).run();
    const d = deriveProfileFromResume(resume);
    await db.prepare("INSERT INTO user_profile (user_id, target_titles_json, keywords_json, locations_json) VALUES (?, ?, ?, ?)")
      .bind(id, JSON.stringify(d.target_titles), JSON.stringify(d.keywords), JSON.stringify(d.locations)).run();
  }
  return id;
}

const nurseResume = "Jane Doe\nRegistered Nurse, BSN\nPatient care, triage, IV therapy, wound care, Epic charting.";
const sweResume = "John Dev\nSenior Software Engineer\nNode.js, TypeScript, React, distributed systems, PostgreSQL.";

const nurseId = await addUser({ email: "nurse@example.com", name: "Jane", resume: nurseResume, newsletter: true });
const sweId = await addUser({ email: "dev@example.com", name: "John", resume: sweResume, newsletter: true });
await addUser({ email: "quiet@example.com", name: "Quiet", resume: nurseResume, newsletter: false }); // opted out
await addUser({ email: "noresume@example.com", name: "NoResume", resume: null, newsletter: true }); // no resume

await db.prepare("INSERT INTO company (name, slug, industry, source) VALUES ('City General', 'cg', 'Healthcare', 't')").run();
await db.prepare("INSERT INTO company (name, slug, industry, source) VALUES ('CloudScale', 'cs', 'Technology', 't')").run();
const cg = await db.prepare("SELECT id FROM company WHERE slug='cg'").first();
const cs = await db.prepare("SELECT id FROM company WHERE slug='cs'").first();
await db.prepare(`INSERT INTO job (company_id, external_id, title, description_text, location, remote_policy, employment_type, salary_min, salary_max, first_seen_at, is_active, url, source_kind)
  VALUES (?, 'n1', 'Registered Nurse — ICU', 'Registered nurse, patient care, triage, IV therapy, Epic.', 'New York, NY', 'on_site', 'full_time', 95000, 125000, '${scanDay} 08:00:00', 1, 'https://x/n1', 't')`).bind(cg.id).run();
await db.prepare(`INSERT INTO job (company_id, external_id, title, description_text, location, remote_policy, employment_type, salary_min, salary_max, first_seen_at, is_active, url, source_kind)
  VALUES (?, 's1', 'Senior Backend Engineer', 'Node.js, TypeScript, distributed systems, PostgreSQL.', 'Remote', 'remote', 'full_time', 180000, 220000, '${scanDay} 09:00:00', 1, 'https://x/s1', 't')`).bind(cs.id).run();

// ── 1. Fan-out delivers per-user digests ───────────────────────────────
{
  const out = await deliverUserDigests(env, scanDay);
  assert.equal(out.sent, 2, `2 digest emails sent (got ${out.sent}, errors: ${JSON.stringify(out.errors)})`);
  const to = sent.map((m) => m.to).sort();
  assert.deepEqual(to, ["dev@example.com", "nurse@example.com"], `recipients: ${to}`);
  const nurseMail = sent.find((m) => m.to === "nurse@example.com");
  assert.ok(/nurse/i.test(nurseMail.text) && /ICU/i.test(nurseMail.text), "nurse gets the nurse job");
  assert.ok(!/Backend Engineer/.test(nurseMail.text), "nurse does NOT get the SWE job");
  const devMail = sent.find((m) => m.to === "dev@example.com");
  assert.ok(/Backend Engineer/.test(devMail.text), "dev gets the SWE job");
  assert.ok(!/Registered Nurse/.test(devMail.text), "dev does NOT get the nurse job");
  console.log("✓ per-user digests: each subscriber gets only their own matches");
}

// ── 2. Idempotency: second run sends nothing ───────────────────────────
{
  const out = await deliverUserDigests(env, scanDay);
  assert.equal(out.sent, 0, "retry sends 0 (already logged)");
  assert.equal(sent.length, 2, "no duplicate emails");
  const logs = await db.prepare("SELECT COUNT(*) AS n FROM user_digest_log WHERE scan_day = ?").bind(scanDay).first();
  assert.ok(logs.n >= 2, "digest log rows written");
  console.log("✓ digest fan-out is idempotent across retries");
}

// ── 3. Owner excluded (admin digest covers him) ────────────────────────
{
  const ownerLog = await db.prepare(
    "SELECT COUNT(*) AS n FROM user_digest_log l JOIN app_user u ON u.id = l.user_id WHERE u.is_admin = 1 AND l.scan_day = ?"
  ).bind(scanDay).first();
  assert.equal(ownerLog.n, 0, "owner never in user digest log");
  console.log("✓ owner excluded from user digests");
}

// ── 4. Failed sends are retried, not swallowed ─────────────────────────
{
  let fail = true;
  env.EMAIL = { send: async (msg) => { if (fail) throw new Error("smtp down"); sent.push(msg); return { id: "retry-1" }; } };
  const day2 = "2026-09-14";
  await db.prepare(`INSERT INTO job (company_id, external_id, title, description_text, location, remote_policy, employment_type, salary_min, salary_max, first_seen_at, is_active, url, source_kind)
    VALUES (?, 'n2', 'Registered Nurse — ER', 'Registered nurse, emergency room, triage, patient care.', 'New York, NY', 'on_site', 'full_time', 98000, 130000, '${day2} 08:00:00', 1, 'https://x/n2', 't')`).bind(cg.id).run();
  const before = sent.length;
  const out1 = await deliverUserDigests(env, day2);
  assert.equal(out1.sent, 0, "no successful sends during outage");
  const logRow = await db.prepare("SELECT COUNT(*) AS n FROM user_digest_log WHERE user_id = ? AND scan_day = ?").bind(nurseId, day2).first();
  assert.equal(logRow.n, 0, "failed user NOT marked as delivered");
  // Recovery: retry succeeds and logs.
  fail = false;
  const out2 = await deliverUserDigests(env, day2);
  assert.ok(out2.sent >= 1, "retry delivers after recovery");
  const logRow2 = await db.prepare("SELECT COUNT(*) AS n FROM user_digest_log WHERE user_id = ? AND scan_day = ?").bind(nurseId, day2).first();
  assert.equal(logRow2.n, 1, "log written after successful send");
  assert.ok(sent.length > before, "email actually re-sent on retry");
  console.log("✓ failed sends are not marked delivered; retries recover");
}

// ── 5. Subscriber fan-out runs even when the owner digest is skipped ────
{
  const day3 = "2026-09-15";
  await db.prepare(`INSERT INTO job (company_id, external_id, title, description_text, location, remote_policy, employment_type, salary_min, salary_max, first_seen_at, is_active, url, source_kind)
    VALUES (?, 'n3', 'Registered Nurse — Telemetry', 'Registered nurse, telemetry, patient monitoring, patient care.', 'New York, NY', 'on_site', 'full_time', 96000, 128000, '${day3} 08:00:00', 1, 'https://x/n3', 't')`).bind(cg.id).run();
  // Owner digest already handled for this scan day (sent) — the claim fails.
  await db.prepare(`INSERT INTO daily_job_digest (scan_day, scan_started_at, scan_completed_at, email_status, email_sent_at, recipient)
    VALUES (?, '${day3} 07:00:00', '${day3} 07:30:00', 'sent', '${day3} 08:00:00', 'mrswelim@gmail.com')`).bind(day3).run();
  const before = sent.length;
  const out = await deliverDailyDigest(env, day3);
  assert.equal(out.skipped, true, "owner digest skipped (already sent)");
  assert.equal(out.reason, "sent");
  assert.ok(out.user_digests && out.user_digests.sent >= 1,
    `subscriber fan-out still ran despite skipped owner digest (got ${JSON.stringify(out.user_digests)})`);
  assert.ok(sent.length > before, "subscriber email actually sent");
  const logRow = await db.prepare("SELECT COUNT(*) AS n FROM user_digest_log WHERE user_id = ? AND scan_day = ?").bind(nurseId, day3).first();
  assert.equal(logRow.n, 1, "subscriber digest logged for the skipped-owner scan day");
  console.log("✓ subscriber fan-out runs independently of owner digest disposition");
}

console.log("\nuser digest tests passed");

// ── 6. The SCHEDULED path (deliverOldestCompletedDigest) still fans out ──
// This is the function the cron actually calls. Regression: it used to
// return "no_claimable_digest" immediately once the owner digest was sent,
// so subscriber retries after an owner send never ran.
{
  const day4 = "2026-09-16";
  await db.prepare(`INSERT INTO job (company_id, external_id, title, description_text, location, remote_policy, employment_type, salary_min, salary_max, first_seen_at, is_active, url, source_kind)
    VALUES (?, 'n4', 'Registered Nurse — ICU', 'Registered nurse, ICU, critical care, patient care.', 'New York, NY', 'on_site', 'full_time', 100000, 135000, '${day4} 08:00:00', 1, 'https://x/n4', 't')`).bind(cg.id).run();
  // Owner digest already sent for the latest scan day: nothing claimable.
  await db.prepare(`INSERT INTO daily_job_digest (scan_day, scan_started_at, scan_completed_at, email_status, email_sent_at, recipient)
    VALUES (?, '${day4} 07:00:00', '${day4} 07:30:00', 'sent', '${day4} 08:00:00', 'mrswelim@gmail.com')`).bind(day4).run();
  const before = sent.length;
  const out = await deliverOldestCompletedDigest(env);
  assert.equal(out.skipped, true, "no claimable owner digest");
  assert.equal(out.reason, "no_claimable_digest");
  assert.ok(out.user_digests && out.user_digests.sent >= 1,
    `scheduled path still fanned out to subscribers (got ${JSON.stringify(out.user_digests)})`);
  assert.ok(sent.length > before, "subscriber email actually sent via scheduled path");
  const logRow = await db.prepare("SELECT COUNT(*) AS n FROM user_digest_log WHERE user_id = ? AND scan_day = ?").bind(nurseId, day4).first();
  assert.equal(logRow.n, 1, "subscriber digest logged via scheduled path");
  console.log("✓ scheduled path (deliverOldestCompletedDigest) fans out despite sent owner digest");
}

console.log("\nuser digest scheduled-path test passed");
for (const s of env.JOBS_DB.stmts) { try { s.close(); } catch {} }
env.JOBS_DB.db.close();
process.exit(0);
