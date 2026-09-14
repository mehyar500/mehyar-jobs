// scripts/test-job-alerts.mjs
// Tests the free job-alerts feature end to end (with a D1 shim):
//   1. fit.js scoreJob returns human-readable `explain` lines.
//   2. POST /api/me/alerts creates an alert (auth, validation, dupe guard, cap).
//   3. GET /api/me/alerts lists them; DELETE removes one.
//   4. deliverJobAlerts emails only NEW jobs matching the filters since the
//      last send, ranks by fit when the user has a profile, and advances the
//      watermark so re-runs don't resend.
//   5. Alert one-click off tokens round-trip and reject tampering / bad ids.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureSchema } from "../functions/_shared/db.js";
import { scoreJob } from "../functions/_shared/fit.js";
import { signUserToken, signAlertToken, verifyAlertToken, deriveProfileFromResume } from "../functions/_shared/userAuth.js";
import { onRequestPost as alertsPost, onRequestGet as alertsGet, onRequestDelete as alertsDelete } from "../functions/api/me/alerts.js";
import { deliverJobAlerts } from "../scanner-worker/src/alertDigests.js";

class D1Shim {
  constructor() { this.db = new DatabaseSync(":memory:"); }
  prepare(sql) {
    const stmt = this.db.prepare(sql);
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
  ADMIN_SESSION_SECRET: "test-secret-1234567890",
  JOBS_APP_URL: "https://jobs.mehyar.us",
  DIGEST_FROM_EMAIL: "noreply@mehyar.us",
  EMAIL: { send: async (msg) => { sent.push(msg); return { id: `msg-${sent.length}` }; } },
};

await ensureSchema(env);
const db = env.JOBS_DB;

// ── 1. explain lines ───────────────────────────────────────────────
{
  const job = {
    title: "Senior Python Developer",
    description_text: "python, django, rest apis, docker, aws",
    location: "Remote", remote_policy: "remote",
    salary_min: 150000, salary_max: 190000, posted_at: new Date().toISOString(),
  };
  const profile = {
    target_titles: ["Senior Software Engineer"],
    keywords: ["python", "django", "rest", "docker", "aws", "sql"],
    locations: ["Remote"], remote_required: false,
    min_salary_usd: 140000, preferred_industries: ["Technology"],
  };
  const out = scoreJob(job, profile, "Technology");
  assert.ok(Array.isArray(out.explain) && out.explain.length >= 3, "explain has lines");
  assert.ok(out.explain.some((l) => l.includes("python") && l.includes("+20")), "keyword line names matched skills");
  assert.ok(out.explain.some((l) => l.includes("remote")), "location line present");
  assert.ok(out.score > 0 && out.reasons.length > 0, "legacy fields intact");
  console.log("✓ scoreJob explain lines");
}

// ── seed: user + company + jobs ────────────────────────────────────
const userR = await db.prepare(
  "INSERT INTO app_user (username, email, display_name, password_hash, newsletter_opt_in, is_admin) VALUES (?, ?, ?, 'x', 1, 0)"
).bind("nurse1", "nurse1@example.com", "Nurse One").run();
const userId = userR.meta.last_row_id;
const token = await signUserToken(userId, env);
const authed = (method, path, body) => new Request(`https://x${path}`, {
  method,
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: body ? JSON.stringify(body) : undefined,
});

const resume = "Jane Doe\nRegistered Nurse, BSN\nPatient care, triage, IV therapy, wound care, Epic charting.";
await db.prepare("INSERT INTO user_resume (user_id, text, is_active) VALUES (?, ?, 1)").bind(userId, resume).run();
const d = deriveProfileFromResume(resume);
await db.prepare("INSERT INTO user_profile (user_id, target_titles_json, keywords_json, locations_json) VALUES (?, ?, ?, ?)")
  .bind(userId, JSON.stringify(d.target_titles), JSON.stringify(d.keywords), JSON.stringify(d.locations)).run();

const coR = await db.prepare("INSERT INTO company (name, slug, industry, source) VALUES (?, ?, ?, ?)").bind("City Hospital", "city-hospital", "Healthcare", "test").run();
const coId = coR.meta.last_row_id;
async function addJob(title, firstSeen, remotePolicy = "remote") {
  const r = await db.prepare(
    `INSERT INTO job (company_id, external_id, source_kind, title, url, location, remote_policy, employment_type, description_text, is_active, first_seen_at)
     VALUES (?, ?, 'test', ?, ?, 'New York, NY', ?, 'employee', ?, 1, ?)`
  ).bind(coId, "ext-" + title.replace(/[^a-z0-9]+/gi, "-"), title, "https://example.com/" + encodeURIComponent(title), remotePolicy, "Seeking a registered nurse. Patient care, triage, IV therapy.", firstSeen).run();
  return r.meta.last_row_id;
}
// One old job (before watermark), two new jobs (after watermark).
await addJob("Registered Nurse — Old Posting", "2026-09-10 10:00:00", "remote");
await addJob("Registered Nurse — ICU Night Shift", "2026-09-13 10:00:00", "remote");
await addJob("Registered Nurse — ER Day Shift", "2026-09-13 11:00:00", "onsite");

// ── 2. create alert ────────────────────────────────────────────────
{
  const res = await alertsPost({ request: authed("POST", "/api/me/alerts", { q: "nurse", remote: "remote" }), env });
  const j = await res.json();
  assert.equal(res.status, 200, "create 200: " + JSON.stringify(j));
  assert.ok(j.id, "returns id");
  assert.ok(j.name.includes("nurse"), "auto name from filters: " + j.name);

  const empty = await alertsPost({ request: authed("POST", "/api/me/alerts", {}), env });
  assert.equal(empty.status, 400, "empty filters rejected");

  const dupe = await alertsPost({ request: authed("POST", "/api/me/alerts", { q: "nurse", remote: "remote" }), env });
  assert.equal(dupe.status, 409, "duplicate filters rejected");

  const anon = await alertsPost({ request: new Request("https://x/api/me/alerts", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), env });
  assert.equal(anon.status, 401, "anonymous rejected");
  console.log("✓ alert create (validation, dupe guard, auth)");
}

// ── 3. list + delete ───────────────────────────────────────────────
let alertId;
{
  const res = await alertsGet({ request: authed("GET", "/api/me/alerts"), env });
  const j = await res.json();
  assert.equal(j.alerts.length, 1, "one alert listed");
  alertId = j.alerts[0].id;
  assert.deepEqual(j.alerts[0].filters, { q: "nurse", remote: "remote" }, "filters round-trip");

  const del = await alertsDelete({ request: authed("DELETE", `/api/me/alerts?id=${alertId}`), env });
  assert.equal((await del.json()).ok, true, "delete ok");
  const after = await (await alertsGet({ request: authed("GET", "/api/me/alerts"), env })).json();
  assert.equal(after.alerts.length, 0, "alert gone");
  console.log("✓ alert list + delete");
}

// Re-create for the delivery test (watermark starts at creation = now).
const created = await (await alertsPost({ request: authed("POST", "/api/me/alerts", { q: "nurse", remote: "remote" }), env })).json();
alertId = created.id;
// Backdate the watermark so the two "new" jobs are after it.
await db.prepare("UPDATE job_alert SET last_sent_at = '2026-09-13 09:00:00' WHERE id = ?").bind(alertId).run();

// ── 4. delivery: only new matching jobs, fit-ranked, watermark ────
{
  const out = await deliverJobAlerts(env, "2026-09-13");
  assert.equal(out.sent, 1, "one alert email sent: " + JSON.stringify(out));
  assert.equal(sent.length, 1, "EMAIL.send called once");
  const msg = sent[0];
  assert.equal(msg.to, "nurse1@example.com", "sent to the user");
  assert.ok(msg.subject.includes("1 new job"), "subject counts matches: " + msg.subject);
  assert.ok(msg.text.includes("ICU Night Shift"), "new remote job included");
  assert.ok(!msg.text.includes("Old Posting"), "old job (before watermark) excluded");
  assert.ok(!msg.text.includes("ER Day Shift"), "onsite job excluded by remote filter");
  assert.ok(msg.text.includes("/api/public/alert-off?token="), "one-click off link present");

  const row = await db.prepare("SELECT last_sent_at, last_match_count FROM job_alert WHERE id = ?").bind(alertId).first();
  assert.ok(row.last_sent_at > "2026-09-13 09:00:00", "watermark advanced");
  assert.equal(row.last_match_count, 1, "match count stored");

  // Second run: nothing new → no email, watermark still advances.
  const out2 = await deliverJobAlerts(env, "2026-09-13");
  assert.equal(out2.sent, 0, "no resend on second run");
  assert.equal(sent.length, 1, "still one email total");
  assert.equal(out2.skipped_no_matches, 1, "counted as skipped");
  console.log("✓ alert delivery (new-only, fit-ranked, watermark)");
}

// ── 5. alert-off tokens ────────────────────────────────────────────
{
  const tok = await signAlertToken(alertId, userId, env);
  const v = await verifyAlertToken(tok, env);
  assert.deepEqual(v, { alertId, userId }, "token round-trips");
  assert.equal(await verifyAlertToken(tok + "x", env), null, "tampered rejected");
  assert.equal(await verifyAlertToken("bogus", env), null, "bogus rejected");
  console.log("✓ alert-off token sign/verify");
}

// ── 6. send failure: watermark must NOT advance, retry succeeds ──────
{
  const mk = await alertsPost({ request: authed("POST", "/api/me/alerts", { q: "icu" }), env });
  const { id: failId } = await mk.json();
  await db.prepare("UPDATE job_alert SET last_sent_at = '2026-09-13 09:00:00' WHERE id = ?").bind(failId).run();
  const before = (await db.prepare("SELECT last_sent_at FROM job_alert WHERE id = ?").bind(failId).first()).last_sent_at;

  const realSend = env.EMAIL.send;
  env.EMAIL.send = async () => { throw new Error("SMTP exploded"); };
  const out = await deliverJobAlerts(env, "2026-09-13");
  assert.equal(out.sent, 0, "nothing sent on failure");
  assert.equal(sent.length, 1, "no new email recorded");
  assert.ok(out.errors.length >= 1, "failure recorded: " + JSON.stringify(out.errors));
  const afterFail = (await db.prepare("SELECT last_sent_at FROM job_alert WHERE id = ?").bind(failId).first()).last_sent_at;
  assert.equal(afterFail, before, "watermark NOT advanced on send failure — retry stays possible");

  // Retry with a working sender: the same job goes out now.
  env.EMAIL.send = realSend;
  const out2 = await deliverJobAlerts(env, "2026-09-13");
  assert.equal(out2.sent, 1, "retry sends the pending matches");
  assert.equal(sent.length, 2, "second email recorded");
  const afterOk = (await db.prepare("SELECT last_sent_at FROM job_alert WHERE id = ?").bind(failId).first()).last_sent_at;
  assert.ok(afterOk > before, "watermark advanced only after successful send");
  console.log("✓ alert delivery retries after send failure (no silent drops)");

  // Clean up the failure-test alert so the cap test starts from 1 active.
  await alertsDelete({ request: authed("DELETE", `/api/me/alerts?id=${failId}`), env });
}

// ── 7. five-alert cap + resubscribe after delete ───────────────────────
{
  for (const q of ["alpha", "beta", "gamma", "delta"]) {
    const r = await alertsPost({ request: authed("POST", "/api/me/alerts", { q }), env });
    assert.equal(r.status, 200, `alert ${q} created`);
  }
  const sixth = await alertsPost({ request: authed("POST", "/api/me/alerts", { q: "epsilon" }), env });
  assert.equal(sixth.status, 400, "6th alert rejected");
  assert.equal((await sixth.json()).error, "too_many", "cap error code");
  const list = await (await alertsGet({ request: authed("GET", "/api/me/alerts"), env })).json();
  assert.equal(list.alerts.length, 5, "exactly 5 active alerts");

  // Cancel one → resubscribing the same filters works again.
  const victim = list.alerts.find((a) => a.filters.q === "alpha");
  await alertsDelete({ request: authed("DELETE", `/api/me/alerts?id=${victim.id}`), env });
  const re = await alertsPost({ request: authed("POST", "/api/me/alerts", { q: "alpha" }), env });
  assert.equal(re.status, 200, "resubscribe after cancel works");
  const list2 = await (await alertsGet({ request: authed("GET", "/api/me/alerts"), env })).json();
  assert.equal(list2.alerts.length, 5, "back at the cap");
  console.log("✓ alert cap (5), cancel, and resubscribe");
}

// ── 8. one-click alert-off via the public endpoint ─────────────────────
import { onRequestGet as publicGet } from "../functions/api/public/[[path]].js";
{
  const list = await (await alertsGet({ request: authed("GET", "/api/me/alerts"), env })).json();
  const target = list.alerts[0];
  const tok = await signAlertToken(target.id, userId, env);
  const r = await publicGet({ request: new Request(`https://jobs.mehyar.us/api/public/alert-off?token=${encodeURIComponent(tok)}`), env });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes("Alert turned off"), "confirmation page");
  const row = await db.prepare("SELECT is_active FROM job_alert WHERE id = ?").bind(target.id).first();
  assert.equal(row.is_active, 0, "alert deactivated by signed link");

  const bad = await publicGet({ request: new Request("https://jobs.mehyar.us/api/public/alert-off?token=bogus"), env });
  assert.ok((await bad.text()).includes("expired"), "bogus token shows expired page");
  console.log("✓ public alert-off link deactivates the alert");
}

// NOTE: node:sqlite segfaults on teardown (close() and natural exit) with
// open prepared statements on Node 24 — exit explicitly once asserts pass.
console.log("\nAll job-alert tests passed ✅");
process.exit(0);
