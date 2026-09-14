// scripts/test-review.mjs
// Tests the LLM resume-review endpoint (scanner-worker/src/review.js) with a
// mocked Workers AI binding: auth, validation, JSON parsing, persistence.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureSchema } from "../functions/_shared/db.js";
import { handleReview } from "../scanner-worker/src/review.js";
import { signUserToken } from "../functions/_shared/userAuth.js";

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

const REVIEW_JSON = {
  score: 72,
  verdict: "Strong backend profile with quantified impact.",
  strengths: ["Quantified achievements", "In-demand stack"],
  gaps: ["No cloud certs", "Short tenures"],
  missing_keywords: ["Kubernetes", "Terraform"],
  suggested_titles: ["Senior Backend Engineer", "Platform Engineer"],
  improvements: ["Add metrics to every bullet", "Add a skills section"],
};

const env = {
  JOBS_DB: new D1Shim(),
ADMIN_SESSION_SECRET: "test-secret-for-review-tests",
  AI: { run: async () => ({ response: `Here you go:\n${JSON.stringify(REVIEW_JSON)}\nDone.` }) },
};
await ensureSchema(env);
const db = env.JOBS_DB;

const resumeText = "Jane Dev\nSenior Software Engineer\nBuilt APIs serving 10M req/day. Node.js, TypeScript, PostgreSQL, AWS.\nLed team of 5. Cut latency 40%. ".repeat(6);
const u = await db.prepare(
  "INSERT INTO app_user (username, email, display_name, password_hash, newsletter_opt_in, is_admin) VALUES ('janedev', 'jane@example.com', 'Jane', 'x', 1, 0)"
).run();
const userId = u.meta.last_row_id;
await db.prepare("INSERT INTO user_resume (user_id, text, is_active) VALUES (?, ?, 1)").bind(userId, resumeText).run();
const token = await signUserToken(userId, env);

function req(body, bearer = token) {
  return new Request("https://worker.test/review", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
}

// ── 1. Happy path: reviews the saved resume, persists the result ──────
{
  const res = await handleReview(req({}), env);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.equal(out.review.score, 72);
  assert.equal(out.review.verdict, REVIEW_JSON.verdict);
  assert.deepEqual(out.review.suggested_titles, REVIEW_JSON.suggested_titles);
  const row = await db.prepare("SELECT llm_review_json FROM user_resume WHERE user_id = ? AND is_active = 1").bind(userId).first();
  assert.ok(row.llm_review_json, "review persisted on the resume row");
  assert.equal(JSON.parse(row.llm_review_json).score, 72);
  console.log("✓ review happy path: scored, structured, persisted");
}

// ── 2. Explicit resume_text in the body (not persisted) ────────────────
{
  const res = await handleReview(req({ resume_text: resumeText }), env);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.equal(typeof out.review.score, "number");
  console.log("✓ explicit resume_text reviewed");
}

// ── 3. Auth required ───────────────────────────────────────────────────
{
  const res = await handleReview(req({}, null), env);
  assert.equal(res.status, 401);
  const out = await res.json();
  assert.equal(out.ok, false);
  console.log("✓ missing token rejected");
}

// ── 4. AI binding missing → 503, not a crash ───────────────────────────
{
  const res = await handleReview(req({}), { ...env, AI: null });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "ai_unavailable");
  console.log("✓ missing AI binding returns 503");
}

// ── 5. Unparseable model output → 502 ──────────────────────────────────
{
  const bad = { ...env, AI: { run: async () => ({ response: "sorry, no json here" }) } };
  const res = await handleReview(req({}), bad);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "ai_parse_error");
  console.log("✓ unparseable model output returns 502");
}

// ── 6. Score clamping ──────────────────────────────────────────────────
{
  const wild = { ...env, AI: { run: async () => ({ response: JSON.stringify({ ...REVIEW_JSON, score: 140 }) }) } };
  const res = await handleReview(req({}), wild);
  assert.equal((await res.json()).review.score, 100);
  console.log("✓ score clamped to 0-100");
}

// ── 7. No resume and no text → 400 ─────────────────────────────────────
{
  const u2 = await db.prepare(
    "INSERT INTO app_user (username, email, display_name, password_hash, newsletter_opt_in, is_admin) VALUES ('nores', 'nores@example.com', 'No', 'x', 1, 0)"
  ).run();
  const t2 = await signUserToken(u2.meta.last_row_id, env);
  const res = await handleReview(req({}, t2), env);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "no_resume");
  console.log("✓ missing resume returns 400");
}

console.log("\nreview endpoint tests passed");
for (const s of env.JOBS_DB.stmts) { try { s.close(); } catch {} }
env.JOBS_DB.db.close();
process.exit(0);
