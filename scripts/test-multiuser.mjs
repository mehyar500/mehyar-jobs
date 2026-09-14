// scripts/test-multiuser.mjs
// Tests for the public multi-user conversion: password auth, resume-derived
// profiles across industries, owner migration idempotency, per-user scoring
// isolation, and session tokens. Uses an in-memory mock of the D1 binding.
import assert from "node:assert/strict";
import {
  hashPassword, verifyPassword, signUserToken, requireUser, ensureOwnerAccount,
  deriveProfileFromResume, getUserFitProfile, isOwnerTokenUser,
} from "../functions/_shared/userAuth.js";
import { scoreJob } from "../functions/_shared/fit.js";

// ── Minimal in-memory D1 mock (mirrors the real queries) ───────────────
function makeDb() {
  const tables = {
    app_user: [], user_resume: [], user_profile: [],
    profile: [{
      id: 1, full_name: "Mehyar Swelim",
      resume_text: "Senior software engineer. Node.js, TypeScript, React, distributed systems, PostgreSQL, Kubernetes.",
      resume_filename: "resume.pdf", resume_mime: "application/pdf", resume_base64: null,
      target_titles_json: JSON.stringify(["Senior Software Engineer", "Backend Engineer"]),
      keywords_json: JSON.stringify(["node.js", "typescript", "react", "distributed systems", "postgresql"]),
      exclude_keywords_json: "[]", locations_json: JSON.stringify(["New York, NY"]),
      remote_required: 0, min_salary_usd: null,
      preferred_industries_json: "[]", excluded_industries_json: "[]", notes: null,
    }],
  };
  const ids = { app_user: 1, user_resume: 1 };
  const norm = (s) => String(s).replace(/\s+/g, " ").trim();

  function q(sql, params) {
    const n = norm(sql);
    // INSERT app_user → D1 result shape { meta: { last_row_id } }
    if (n.startsWith("INSERT INTO app_user")) {
      const row = { id: ids.app_user++, username: params[0], email: params[1], password_hash: "env-admin", display_name: "Mehyar Swelim", is_admin: 1, newsletter_opt_in: 1 };
      tables.app_user.push(row);
      return { meta: { last_row_id: row.id } };
    }
    if (n.startsWith("INSERT INTO user_resume")) {
      const row = { id: ids.user_resume++, user_id: params[0], filename: params[1], mime: params[2], base64: params[3], text: params[4], is_active: 1 };
      tables.user_resume.push(row); return { meta: { last_row_id: row.id } };
    }
    if (n.startsWith("INSERT OR IGNORE INTO user_profile")) {
      if (!tables.user_profile.some((p) => p.user_id === params[0])) {
        tables.user_profile.push({ user_id: params[0], target_titles_json: params[1], keywords_json: params[2], exclude_keywords_json: params[3], locations_json: params[4], remote_required: params[5], min_salary_usd: params[6], preferred_industries_json: params[7], excluded_industries_json: params[8], notes: params[9] });
      }
      return {};
    }
    // SELECTs
    if (n === "SELECT * FROM app_user WHERE lower(username) = 'mehyar500' OR lower(email) = ?") {
      return tables.app_user.filter((u) => String(u.username).toLowerCase() === "mehyar500" || String(u.email).toLowerCase() === String(params[0]).toLowerCase());
    }
    if (n === "SELECT * FROM app_user WHERE lower(username) = ? OR lower(email) = ?") {
      const s = String(params[0]).toLowerCase();
      return tables.app_user.filter((u) => String(u.username).toLowerCase() === s || String(u.email).toLowerCase() === s);
    }
    if (n === "SELECT * FROM app_user WHERE id = ?") return tables.app_user.filter((u) => u.id === params[0]);
    if (n === "SELECT 1 AS x FROM user_resume WHERE user_id = ? LIMIT 1") return tables.user_resume.some((r) => r.user_id === params[0]) ? [{ x: 1 }] : [];
    if (n === "SELECT 1 AS x FROM user_profile WHERE user_id = ? LIMIT 1") return tables.user_profile.some((p) => p.user_id === params[0]) ? [{ x: 1 }] : [];
    if (n === "SELECT * FROM profile WHERE id = 1") return tables.profile;
    if (n === "SELECT * FROM user_profile WHERE user_id = ?") return tables.user_profile.filter((p) => p.user_id === params[0]);
    if (n === "SELECT text FROM user_resume WHERE user_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 1") {
      const rows = tables.user_resume.filter((r) => r.user_id === params[0] && r.is_active).sort((a, b) => b.id - a.id);
      return rows.length ? [{ text: rows[0].text }] : [];
    }
    throw new Error(`unmocked query: ${n.slice(0, 80)}`);
  }
  return {
    tables,
    prepare(sql) {
      return {
        bind: (...params) => ({
          first: async () => { const r = q(sql, params); return Array.isArray(r) ? (r[0] || null) : null; },
          all: async () => ({ results: q(sql, params) }),
          run: async () => q(sql, params),
        }),
        first: async () => { const r = q(sql, []); return Array.isArray(r) ? (r[0] || null) : null; },
        all: async () => ({ results: q(sql, []) }),
        run: async () => q(sql, []),
      };
    },
  };
}
const env = { JOBS_DB: makeDb(), MEHYARSOFT_ADMIN_USERNAME: "Mehyar500", NOTIFY_EMAIL: "mrswelim@gmail.com" };

// ── 1. Password hashing ────────────────────────────────────────────────
{
  const h = await hashPassword("supersecret1");
  assert.ok(h.startsWith("pbkdf2-sha256$"), "hash format");
  assert.ok(await verifyPassword("supersecret1", h), "verify correct");
  assert.ok(!(await verifyPassword("wrongpass1", h)), "reject wrong");
  assert.ok(!(await verifyPassword("supersecret1", "env-admin")), "env-admin sentinel is not verifiable");
  console.log("✓ password hashing/verification");
}

// ── 2. Owner migration + idempotency ───────────────────────────────────
{
  const first = await ensureOwnerAccount(env);
  assert.ok(first && first.id, "owner created on first run");
  assert.equal(first.username, "Mehyar500");
  assert.equal(first.email, "mrswelim@gmail.com");
  assert.equal(first.is_admin, 1);
  assert.equal(first.password_hash, "env-admin");
  const countAfterFirst = env.JOBS_DB.tables.app_user.length;

  const second = await ensureOwnerAccount(env);
  assert.ok(second && second.id === first.id, "same owner on second run");
  assert.equal(env.JOBS_DB.tables.app_user.length, countAfterFirst, "idempotent — no duplicate owner");
  assert.equal(env.JOBS_DB.tables.user_resume.length, 1, "resume migrated exactly once");
  assert.equal(env.JOBS_DB.tables.user_profile.length, 1, "profile migrated exactly once");

  const resume = env.JOBS_DB.tables.user_resume[0];
  assert.ok(resume.text.includes("Senior software engineer"), "resume text migrated");
  const prof = env.JOBS_DB.tables.user_profile[0];
  assert.ok(JSON.parse(prof.keywords_json).includes("typescript"), "fit keywords migrated");
  assert.ok(isOwnerTokenUser(first), "owner flagged as owner-token user");
  console.log("✓ owner account migration (idempotent, resume copied)");
}

// ── 3. Resume derivation across industries ─────────────────────────────
{
  const nurse = deriveProfileFromResume("Jane Doe\nRegistered Nurse, BSN\nPatient care, triage, IV therapy, wound care, Epic charting, medication administration.");
  assert.ok(nurse.keywords.some((k) => ["nurse", "patient", "triage"].includes(k)), `nurse keywords: ${nurse.keywords.slice(0, 6)}`);
  assert.ok(nurse.target_titles.some((t) => /nurse/i.test(t)), `nurse titles: ${nurse.target_titles}`);

  const driver = deriveProfileFromResume("John Smith\nCDL Class A Truck Driver\nLong haul, forklift certified, route planning, DOT compliance.");
  assert.ok(driver.target_titles.some((t) => /driver/i.test(t)), `driver titles: ${driver.target_titles}`);

  const designer = deriveProfileFromResume("Alex Lee\nProduct Designer\nFigma, design systems, user research, prototyping, interaction design.");
  assert.ok(designer.target_titles.some((t) => /designer/i.test(t)), `designer titles: ${designer.target_titles}`);
  console.log("✓ resume derivation across industries (nurse / driver / designer)");
}

// ── 4. Per-user scoring isolation ──────────────────────────────────────
{
  const nurseProfile = {
    target_titles: ["Registered Nurse", "RN"],
    keywords: ["nurse", "registered nurse", "patient care", "triage", "iv therapy", "epic"],
    exclude_keywords: [], locations: [], remote_required: false,
    min_salary_usd: null, preferred_industries: [], excluded_industries: [],
  };
  const nurseJob = { title: "Registered Nurse — ICU Night Shift", description_text: "Seeking a registered nurse for ICU. Patient care, triage, IV therapy, Epic charting.", location: "New York, NY", remote_policy: "on_site", salary_min: 90000, salary_max: 120000, posted_at: null };
  const sweJob = { title: "Senior Backend Engineer", description_text: "Node.js, TypeScript, distributed systems, PostgreSQL, Kubernetes.", location: "Remote", remote_policy: "remote", salary_min: 180000, salary_max: 220000, posted_at: null };
  const nurseScore = scoreJob(nurseJob, nurseProfile, "Healthcare");
  const sweScore = scoreJob(sweJob, nurseProfile, "Technology");
  assert.ok(nurseScore.score >= 60, `nurse job scores high for nurse: ${nurseScore.score}`);
  assert.ok(sweScore.score < 35, `SWE job scores low for nurse: ${sweScore.score}`);
  console.log("✓ per-user scoring isolation");
}

// ── 5. Session tokens ──────────────────────────────────────────────────
{
  const db = env.JOBS_DB;
  db.tables.app_user.push({ id: 42, username: "tester", email: "t@example.com", display_name: "T", password_hash: "pbkdf2-sha256$x", newsletter_opt_in: 1, is_admin: 0 });
  const tok = await signUserToken(42, { ADMIN_SESSION_SECRET: "test-secret-1234567890" }, 60);
  const req = new Request("https://x/api/me", { headers: { authorization: `Bearer ${tok}` } });
  const ok = await requireUser(req, { JOBS_DB: db, ADMIN_SESSION_SECRET: "test-secret-1234567890" });
  assert.ok(ok.ok && ok.user.id === 42, "token round-trips through requireUser");
  const bad = await requireUser(req, { JOBS_DB: db, ADMIN_SESSION_SECRET: "wrong-secret-xyz" });
  assert.ok(!bad.ok, "wrong secret rejected");
  const tampered = await requireUser(new Request("https://x/api/me", { headers: { authorization: "Bearer nope.nope" } }), { JOBS_DB: db, ADMIN_SESSION_SECRET: "test-secret-1234567890" });
  assert.ok(!tampered.ok, "garbage token rejected");
  console.log("✓ session token sign/verify");
}

// ── 6. getUserFitProfile loads saved resume-derived profile ────────────
{
  const ownerId = env.JOBS_DB.tables.app_user.find((u) => u.is_admin === 1).id;
  const prof = await getUserFitProfile(env, ownerId);
  assert.ok(prof.keywords.includes("typescript"), "keywords loaded from migrated profile");
  assert.ok(prof.target_titles.includes("Senior Software Engineer"), "titles loaded");
  assert.ok(prof.resume_text.includes("Senior software engineer"), "resume text loaded");
  const missing = await getUserFitProfile(env, 99999);
  assert.ok(!missing.keywords.length && !missing.resume_text, "unknown user → empty profile");
  console.log("✓ getUserFitProfile loads migrated owner profile");
}

console.log("\nmulti-user tests passed");
