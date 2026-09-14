// scripts/test-unsubscribe.mjs
// Tests the newsletter unsubscribe flow: signed one-click tokens and the
// GET /api/newsletter/unsubscribe endpoint.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureSchema } from "../functions/_shared/db.js";
import { signUnsubscribeToken, verifyUnsubscribeToken } from "../functions/_shared/userAuth.js";
import { onRequestGet } from "../functions/api/newsletter/unsubscribe.js";

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

const env = { JOBS_DB: new D1Shim(), ADMIN_SESSION_SECRET: "test-secret-for-unsub-tests" };
await ensureSchema(env);
const db = env.JOBS_DB;

await db.prepare(
  "INSERT INTO app_user (username, email, display_name, password_hash, newsletter_opt_in, is_admin) VALUES ('sub1', 'Sub@Example.com', 'Sub', 'x', 1, 0)"
).run();

// ── 1. Token round-trip (email normalized to lowercase) ───────────────
{
  const token = await signUnsubscribeToken("Sub@Example.com", env);
  const email = await verifyUnsubscribeToken(token, env);
  assert.equal(email, "sub@example.com");
  console.log("✓ token round-trip verifies, email normalized");
}

// ── 2. Tampered / wrong-secret / garbage tokens fail ──────────────────
{
  const token = await signUnsubscribeToken("sub@example.com", env);
  const tampered = token.slice(0, -2) + "xx";
  assert.equal(await verifyUnsubscribeToken(tampered, env), null);
  assert.equal(await verifyUnsubscribeToken("garbage", env), null);
  assert.equal(await verifyUnsubscribeToken("", env), null);
  assert.equal(await verifyUnsubscribeToken(token, { ...env, ADMIN_SESSION_SECRET: "other" }), null);
  console.log("✓ tampered and wrong-secret tokens rejected");
}

// ── 3. GET endpoint unsubscribes the matching account ──────────────────
{
  const token = await signUnsubscribeToken("sub@example.com", env);
  const request = new Request(`https://jobs.mehyar.us/api/newsletter/unsubscribe?token=${encodeURIComponent(token)}`);
  const res = await onRequestGet({ request, env });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.equal(out.email, "sub@example.com");
  const row = await db.prepare("SELECT newsletter_opt_in FROM app_user WHERE lower(email) = 'sub@example.com'").first();
  assert.equal(row.newsletter_opt_in, 0, "opt_in cleared in DB");
  console.log("✓ one-click unsubscribe clears newsletter_opt_in");
}

// ── 4. Invalid token → 400, nothing changes ────────────────────────────
{
  const request = new Request("https://jobs.mehyar.us/api/newsletter/unsubscribe?token=bogus");
  const res = await onRequestGet({ request, env });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).ok, false);
  console.log("✓ invalid token rejected with 400");
}

// ── 5. Idempotent: unsubscribing twice is fine ──────────────────────────
{
  const token = await signUnsubscribeToken("sub@example.com", env);
  const request = new Request(`https://jobs.mehyar.us/api/newsletter/unsubscribe?token=${encodeURIComponent(token)}`);
  const res = await onRequestGet({ request, env });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  console.log("✓ repeat unsubscribe is idempotent");
}

console.log("\nunsubscribe flow tests passed");
for (const s of env.JOBS_DB.stmts) { try { s.close(); } catch {} }
env.JOBS_DB.db.close();
process.exit(0);
