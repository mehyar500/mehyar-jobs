// scripts/test-e2e-user.mjs
// End-to-end test of the public multi-user flows through the REAL Pages
// Functions with a REAL SQLite database (node:sqlite) behind a D1-compatible
// shim. Runs the real migrations, real auth, real scoring, real queries.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureSchema } from "../functions/_shared/db.js";

// ── D1-compatible shim over node:sqlite ─────────────────────────────────
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
    return {
      bind: (...params) => wrap(params),
      first: () => wrap([]).first(),
      all: () => wrap([]).all(),
      run: () => wrap([]).run(),
    };
  }
  async batch(list) {
    const out = [];
    this.db.exec("BEGIN");
    try { for (const s of list) out.push(await s.run()); this.db.exec("COMMIT"); }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
    return out;
  }
  async exec(sql) { this.db.exec(sql); return { success: true }; }
}

const env = {
  JOBS_DB: new D1Shim(),
  ADMIN_SESSION_SECRET: "e2e-test-secret-0123456789",
  MEHYARSOFT_ADMIN_USERNAME: "Mehyar500",
  MEHYARSOFT_ADMIN_PASSWORD: "owner-pass-123",
  NOTIFY_EMAIL: "mrswelim@gmail.com",
  JOBS_APP_URL: "https://jobs.mehyar.us",
  // Admin endpoints verify cross-app SSO tokens with this secret (pre-existing).
  MESC_JWT_SECRET: "e2e-admin-sso-secret-xyz",
};

const post = (body, token) => new Request("https://x/api", {
  method: "POST",
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});
const get = (url, token) => new Request(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
const read = async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) });

const signup = (await import("../functions/api/auth/signup.js")).onRequestPost;
const userLogin = (await import("../functions/api/auth/user-login.js")).onRequestPost;
const adminLogin = (await import("../functions/api/auth/login.js")).onRequestPost;
const meGet = (await import("../functions/api/me/index.js")).onRequestGet;
const resumePost = (await import("../functions/api/me/resume.js")).onRequestPost;
const runPost = (await import("../functions/api/me/run.js")).onRequestPost;
const matchesGet = (await import("../functions/api/me/matches.js")).onRequestGet;
const newsletterPost = (await import("../functions/api/me/newsletter.js")).onRequestPost;
const jobsGet = (await import("../functions/api/jobs.js")).onRequestGet;

// ── 0. Real migrations apply cleanly ───────────────────────────────────
{
  await ensureSchema(env);
  const migs = await env.JOBS_DB.prepare("SELECT name FROM __migrations ORDER BY name").all();
  const names = migs.results.map((r) => r.name);
  assert.ok(names.includes("0008_multiuser.sql"), "0008 applied");
  assert.ok(names.includes("0009_user_digest_log.sql"), "0009 applied");
  const tables = await env.JOBS_DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('app_user','user_resume','user_profile','user_job_fit','user_digest_log')").all();
  assert.equal(tables.results.length, 5, "all 5 new tables exist");
  // Owner account seeded by ensureSchema
  const owner = await env.JOBS_DB.prepare("SELECT * FROM app_user WHERE is_admin = 1").first();
  assert.ok(owner && owner.username === "Mehyar500", "owner seeded");
  console.log("✓ real migrations apply; 5 new tables; owner seeded");
}

// ── 1. Marketing consent is separate from account creation ─────────────
{
  const r = await read(await signup({ request: post({ email: "optout@example.com", password: "password123", newsletter_opt_in: false }), env }));
  assert.equal(r.status, 200, `signup without newsletter opt-in works (got ${r.status})`);
  assert.ok(r.body.token, "token issued without newsletter");
  const row = await env.JOBS_DB.prepare("SELECT newsletter_opt_in FROM app_user WHERE email = ?").bind("optout@example.com").first();
  assert.equal(row.newsletter_opt_in, 0, "opt-out stored as 0");
  console.log("✓ signup works without newsletter opt-in (separate consent)");
}

// ── 2. Happy-path signup ───────────────────────────────────────────────
let token;
{
  const r = await read(await signup({
    request: post({ email: "nurse@example.com", password: "password123", display_name: "Jane Doe", title: "Registered Nurse", location: "New York, NY", newsletter_opt_in: true }),
    env,
  }));
  assert.equal(r.status, 200, `signup 200 (got ${r.status}: ${JSON.stringify(r.body).slice(0, 160)})`);
  assert.ok(r.body.token, "token issued");
  const row = await env.JOBS_DB.prepare("SELECT newsletter_opt_in FROM app_user WHERE email = ?").bind("nurse@example.com").first();
  assert.equal(row.newsletter_opt_in, 1, "newsletter opt-in stored");
  token = r.body.token;
  const dup = await read(await signup({ request: post({ email: "nurse@example.com", password: "password123", newsletter_opt_in: true }), env }));
  assert.equal(dup.status, 409, "duplicate email rejected");
  const short = await read(await signup({ request: post({ email: "x2@example.com", password: "short", newsletter_opt_in: true }), env }));
  assert.equal(short.status, 400, "short password rejected");
  console.log("✓ signup happy path + duplicate/short-password guards");
}

// ── 3. Login ───────────────────────────────────────────────────────────
{
  const bad = await read(await userLogin({ request: post({ email: "nurse@example.com", password: "wrongpass9" }), env }));
  assert.equal(bad.status, 401, "wrong password → 401");
  const ok = await read(await userLogin({ request: post({ email: "nurse@example.com", password: "password123" }), env }));
  assert.equal(ok.status, 200, "correct login → 200");
  assert.ok(ok.body.token, "login token issued");
  console.log("✓ user login (wrong → 401, right → 200)");
}

// ── 4. /me + resume upload ─────────────────────────────────────────────
{
  const me = await read(await meGet({ request: get("https://x/api/me", token), env }));
  assert.equal(me.status, 200, "/me 200");
  assert.equal(me.body.user.has_resume, false, "no resume yet");

  const noAuth = await read(await meGet({ request: get("https://x/api/me"), env }));
  assert.equal(noAuth.status, 401, "/me without token → 401");

  const resumeText = "Jane Doe\nRegistered Nurse, BSN\nPatient care, triage, IV therapy, wound care, Epic charting, medication administration. 6 years ICU experience.";
  const sv = await read(await resumePost({ request: post({ resume_text: resumeText, current_title: "Registered Nurse" }, token), env }));
  assert.equal(sv.status, 200, `resume save 200 (got ${sv.status})`);
  assert.ok(sv.body.derived.keyword_count >= 5, `keywords extracted (${sv.body.derived.keyword_count})`);

  const me2 = await read(await meGet({ request: get("https://x/api/me", token), env }));
  assert.equal(me2.body.user.has_resume, true, "resume now on file");
  console.log("✓ /me + resume upload with keyword extraction");
}

// ── 5. Seed jobs, run, matches ─────────────────────────────────────────
{
  const db = env.JOBS_DB;
  await db.prepare("INSERT INTO company (name, slug, industry, source) VALUES ('City General Hospital', 'city-general', 'Healthcare', 'test')").run();
  await db.prepare("INSERT INTO company (name, slug, industry, source) VALUES ('CloudScale Inc', 'cloudscale', 'Technology', 'test')").run();
  const co1 = await db.prepare("SELECT id FROM company WHERE slug = 'city-general'").first();
  const co2 = await db.prepare("SELECT id FROM company WHERE slug = 'cloudscale'").first();
  await db.prepare(`INSERT INTO job (company_id, external_id, title, description_text, location, remote_policy, employment_type, salary_min, salary_max, posted_at, first_seen_at, is_active, url, source_kind)
    VALUES (?, 'h1', 'Registered Nurse — ICU', 'Registered nurse needed for ICU. Patient care, triage, IV therapy, Epic charting.', 'New York, NY', 'on_site', 'full_time', 95000, 125000, datetime('now'), datetime('now'), 1, 'https://example.com/j1', 'test')`).bind(co1.id).run();
  await db.prepare(`INSERT INTO job (company_id, external_id, title, description_text, location, remote_policy, employment_type, salary_min, salary_max, posted_at, first_seen_at, is_active, url, source_kind)
    VALUES (?, 'c1', 'Senior Backend Engineer', 'Node.js, TypeScript, distributed systems, PostgreSQL, Kubernetes.', 'Remote', 'remote', 'full_time', 180000, 220000, datetime('now'), datetime('now'), 1, 'https://example.com/j2', 'test')`).bind(co2.id).run();

  const run = await read(await runPost({ request: post({}, token), env }));
  assert.equal(run.status, 200, `run 200 (got ${run.status}: ${JSON.stringify(run.body).slice(0, 200)})`);
  assert.ok(run.body.matches >= 1, `at least one match (got ${run.body.matches})`);
  const topTitles = (run.body.top || []).map((t) => t.title);
  assert.ok(topTitles.some((t) => /nurse/i.test(t)), `nurse job in top: ${topTitles}`);
  assert.ok(!topTitles.some((t) => /backend engineer/i.test(t)), "SWE job NOT matched to nurse");

  const m = await read(await matchesGet({ request: get("https://x/api/me/matches?limit=30", token), env }));
  assert.equal(m.status, 200, "matches 200");
  assert.ok(m.body.total >= 1, "matches persisted");
  console.log("✓ run scores jobs against the user's own resume; matches persist");
}

// ── 6. Newsletter toggle ───────────────────────────────────────────────
{
  const off = await read(await newsletterPost({ request: post({ opt_in: false }, token), env }));
  assert.equal(off.status, 200, "toggle 200");
  assert.equal(off.body.newsletter_opt_in, false, "opted out");
  const on = await read(await newsletterPost({ request: post({ opt_in: true }, token), env }));
  assert.equal(on.body.newsletter_opt_in, true, "opted back in");
  console.log("✓ newsletter toggle");
}

// ── 7. Public jobs browsing (no auth) ──────────────────────────────────
{
  const r = await read(await jobsGet({ request: get("https://x/api/jobs?q=nurse&limit=10"), env }));
  assert.equal(r.status, 200, "public jobs 200");
  assert.ok(r.body.total >= 1, "public jobs visible");
  assert.ok(!(r.body.jobs[0] || {}).description_text, "no description text leaked in list view");
  const ind = await read(await jobsGet({ request: get("https://x/api/jobs?industry=Technology&limit=10"), env }));
  assert.ok(ind.body.total >= 1, "industry filter works");
  console.log("✓ public job browsing (no login wall)");
}

// ── 8. Admin isolation: user token can't touch admin endpoints ──────────
{
  const profile = await import("../functions/api/admin/profile.js");
  const handler = profile.onRequestGet || profile.onRequest;
  if (handler) {
    const r = await read(await handler({ request: get("https://x/api/admin/profile", token), env }));
    assert.ok([401, 403].includes(r.status), `user blocked from admin (got ${r.status})`);
    console.log("✓ user token blocked from admin endpoints");
  } else {
    console.log("⊘ admin profile endpoint has no GET handler — skipped");
  }
}

// ── 9. Owner keeps existing admin login ─────────────────────────────────
{
  const r = await read(await adminLogin({ request: post({ username: "Mehyar500", password: "owner-pass-123" }), env }));
  assert.equal(r.status, 200, `admin login 200 (got ${r.status})`);
  const me = await read(await meGet({ request: get("https://x/api/me", r.body.token), env }));
  assert.equal(me.status, 200, "owner token works on /me");
  assert.ok(me.body.user.is_admin, "owner recognized as admin");
  console.log("✓ owner's existing admin login still works, maps to owner account");
}

console.log("\ne2e user-flow tests passed");
// node:sqlite can segfault during GC at process exit under npm; finalize
// every statement, close the DB, then hard-exit.
for (const s of env.JOBS_DB.stmts) { try { s.close(); } catch {} }
env.JOBS_DB.db.close();
process.exit(0);
