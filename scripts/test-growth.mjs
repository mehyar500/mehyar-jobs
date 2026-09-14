// scripts/test-growth.mjs
// Growth engine end-to-end tests (D1 shim):
//   1. Migration 0013 applies (tables + columns).
//   2. Sponsor admin CRUD + getActiveSponsor windowing + email blocks labeled "Sponsored".
//   3. Featured flag: admin toggle → /api/me/matches returns j.featured.
//   4. request-featured: public POST stores row + notifies admin.
//   5. Roast: mint from llm_review_json, PII-stripped; public page has OG tags.
//   6. Referral: signup ?ref= credits both sides; /api/me/referral backfills code.
//   7. Chat bonus: over-limit member burns a credit instead of 429.
//   8. SEO: job detail page carries JobPosting JSON-LD; listing pages 200 with
//      unique intro; /jobs falls through to the SPA; sitemap + robots.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureSchema } from "../functions/_shared/db.js";
import { signUserToken, hashPassword } from "../functions/_shared/userAuth.js";
import { getActiveSponsor, sponsorEmailHtml, sponsorEmailText } from "../functions/_shared/sponsors.js";
import { jobPostingJsonLd } from "../functions/_shared/seo.js";
import { onRequestGet as sponsorsGet, onRequestPost as sponsorsPost, onRequestDelete as sponsorsDelete } from "../functions/api/admin/sponsors.js";
import { onRequestPost as featurePost } from "../functions/api/admin/jobs/[id]/feature.js";
import { onRequestPost as requestFeatured } from "../functions/api/public/request-featured.js";
import { onRequestGet as sponsoredGet } from "../functions/api/public/sponsored.js";
import { onRequestPost as roastPost } from "../functions/api/me/roast.js";
import { onRequestGet as roastPage } from "../functions/roast/[id].js";
import { onRequestGet as referralGet } from "../functions/api/me/referral.js";
import { onRequestPost as signupPost } from "../functions/api/auth/signup.js";
import { onRequestGet as matchesGet } from "../functions/api/me/matches.js";
import { onRequestGet as jobPage } from "../functions/job/[id].js";
import { onRequestGet as seoPage } from "../functions/jobs/[[seo]].js";
import { onRequestGet as sitemapIndex } from "../functions/sitemap.xml.js";
import { onRequestGet as sitemapChunk } from "../functions/sitemap/[chunk].js";
import { onRequestGet as robots } from "../functions/robots.txt.js";
import { handleChat } from "../scanner-worker/src/chat.js";

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

function b64url(o) {
  return Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
}
async function adminToken(env) {
  const payload = b64url({ sub: "admin", exp: Math.floor(Date.now() / 1000) + 3600 });
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.MESC_JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))).toString("base64url");
  return `${payload}.${sig}`;
}

const sentEmails = [];
const env = {
  JOBS_DB: new D1Shim(),
  ADMIN_SESSION_SECRET: "test-admin-secret",
  MESC_JWT_SECRET: "test-mesc-secret",
  JOBS_APP_URL: "https://jobs.mehyar.us",
  NOTIFY_EMAIL: "owner@example.com",
  EMAIL: { send: async (msg) => ({ id: "m1" }) },
  EMAIL_SENDER_URL: "https://email-sender.test/send",
  AI: { run: async () => ({ response: "Here are matching jobs for you." }) },
};
globalThis.fetch = async (url, opts) => {
  sentEmails.push(JSON.parse(opts.body));
  return { ok: true, json: async () => ({ ok: true, id: "x" }) };
};

await ensureSchema(env);
const db = env.JOBS_DB;
const ADMIN = await adminToken(env);
const adminReq = (method, path, body) => new Request(`https://x${path}`, {
  method, headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
  body: body ? JSON.stringify(body) : undefined,
});
const readJson = async (res) => JSON.parse(await res.text());

// ── 1. migration 0013 ──────────────────────────────────────────────
{
  for (const t of ["sponsor", "featured_request", "roast", "referral_event"]) {
    const r = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(t).first();
    assert.ok(r, `table ${t} exists`);
  }
  const cols = (await db.prepare("PRAGMA table_info(job)").all()).results.map((c) => c.name);
  assert.ok(cols.includes("featured") && cols.includes("featured_until"), "job.featured columns exist");
  const ucols = (await db.prepare("PRAGMA table_info(app_user)").all()).results.map((c) => c.name);
  assert.ok(ucols.includes("referral_code") && ucols.includes("chat_bonus_credits"), "app_user referral columns exist");
  console.log("1. migration 0013 ok");
}

// seed company + jobs
const compR = await db.prepare(
  "INSERT INTO company (name, slug, source, industry) VALUES (?, ?, 'fortune_500', 'Technology')"
).bind("Acme Corp", "acme-corp").run();
const compId = compR.meta.last_row_id;
let seedN = 0;
async function seedJob(title, location, extra = {}) {
  seedN += 1;
  const r = await db.prepare(`INSERT INTO job
    (company_id, external_id, source_kind, url, title, location, remote_policy, employment_type,
     salary_min, salary_max, salary_currency, posted_at, first_seen_at, description_text, featured)
    VALUES (?, ?, 'greenhouse', ?, ?, ?, ?, ?, ?, ?, 'USD', '2026-09-10', datetime('now'), ?, ?)`)
    .bind(compId, `ext-${seedN}-${title}-${location}`.slice(0, 60), `https://acme.example/j/${title}`,
      title, location, extra.remote_policy || "onsite", extra.employment_type || "full_time",
      extra.salary_min ?? 150000, extra.salary_max ?? 200000, "Nice role. " + title, extra.featured || 0).run();
  return r.meta.last_row_id;
}
const jobId1 = await seedJob("Senior Software Engineer", "New York, NY");
await seedJob("Senior Software Engineer", "New York, NY", { salary_min: 160000 });
await seedJob("Senior Software Engineer", "Austin, TX");
await seedJob("Junior Nurse", "New York, NY", { employment_type: "part_time", salary_min: 80000, salary_max: 95000 });

// users
async function seedUser(email, admin = false) {
  const r = await db.prepare(
    "INSERT INTO app_user (email, password_hash, display_name, newsletter_opt_in, is_admin) VALUES (?, 'x', ?, 1, ?)"
  ).bind(email, email.split("@")[0], admin ? 1 : 0).run();
  return r.meta.last_row_id;
}
const userId = await seedUser("member@example.com");
const userToken = await signUserToken(userId, env);
const authed = (method, path, body) => new Request(`https://x${path}`, {
  method, headers: { authorization: `Bearer ${userToken}`, "content-type": "application/json" },
  body: body ? JSON.stringify(body) : undefined,
});

// ── 2. sponsors CRUD + active windowing + email blocks ──────────────
{
  const bad = await readJson(await sponsorsGet({ request: adminReq("GET", "/api/admin/sponsors"), env }));
  assert.ok(bad.ok && bad.sponsors.length === 0);

  const create = await readJson(await sponsorsPost({
    request: adminReq("POST", "/api/admin/sponsors", {
      name: "ResumePro", headline: "Get hired 2x faster", body: "Pro resume rewrite",
      cta_text: "Try it", cta_url: "https://resumepro.example", slot: "email",
    }), env,
  }));
  assert.ok(create.ok && create.id, "sponsor created");

  // expired one must NOT win
  await readJson(await sponsorsPost({
    request: adminReq("POST", "/api/admin/sponsors", {
      name: "Old", headline: "Expired", cta_url: "https://old.example", slot: "email",
      starts_at: "2020-01-01", ends_at: "2020-02-01",
    }), env,
  }));

  const active = await getActiveSponsor(db, "email");
  assert.equal(active.name, "ResumePro", "active sponsor = newest in-window");

  const html = sponsorEmailHtml(active);
  assert.ok(html.includes("Sponsored") && html.includes("Get hired 2x faster"), "html block labeled");
  const text = sponsorEmailText(active).join("\n");
  assert.ok(text.includes("Sponsored") && text.includes("https://resumepro.example"), "text block labeled");

  // public sponsored endpoint
  const pub = await readJson(await sponsoredGet({ request: new Request("https://x/api/public/sponsored?slot=email"), env }));
  assert.ok(pub.ok && pub.sponsor.name === "ResumePro");

  // matches slot empty → null, no crash
  const pubM = await readJson(await sponsoredGet({ request: new Request("https://x/api/public/sponsored?slot=matches"), env }));
  assert.ok(pubM.ok && pubM.sponsor === null);

  // delete
  const del = await readJson(await sponsorsDelete({ request: adminReq("DELETE", `/api/admin/sponsors?id=${create.id}`), env }));
  assert.ok(del.ok, "sponsor deleted");
  console.log("2. sponsors ok");
}

// ── 3. featured flag → matches badge ───────────────────────────────
{
  const f = await readJson(await featurePost({
    request: adminReq("POST", `/api/admin/jobs/${jobId1}/feature`, { featured: 1, featured_until: "2026-12-31" }),
    env, params: { id: String(jobId1) },
  }));
  assert.ok(f.ok && f.featured === 1, "featured toggled");

  await db.prepare("INSERT INTO user_job_fit (user_id, job_id, score, reasons) VALUES (?, ?, 90, '[]')")
    .bind(userId, jobId1).run();
  const m = await readJson(await matchesGet({ request: authed("GET", "/api/me/matches?min_score=50"), env }));
  const row = (m.matches || []).find((x) => x.id === jobId1);
  assert.ok(row && row.featured === 1, "matches API exposes featured");
  console.log("3. featured ok");
}

// ── 4. request-featured (public, manual flow) ───────────────────────
{
  const r = await readJson(await requestFeatured({
    request: new Request("https://x/api/public/request-featured", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ company_name: "Acme Corp", contact_email: "hr@acme.example", job_title: "Nurse", job_url: "https://acme.example/j/9" }),
    }), env,
  }));
  assert.ok(r.ok && r.request_id, "request stored");
  const row = await db.prepare("SELECT * FROM featured_request WHERE id = ?").bind(r.request_id).first();
  assert.equal(row.status, "pending");
  assert.ok(sentEmails.length > 0 && sentEmails[0].subject.includes("Featured-post request"), "admin notified");
  const bad = await readJson(await requestFeatured({
    request: new Request("https://x/api/public/request-featured", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ company_name: "", contact_email: "nope" }),
    }), env,
  }));
  assert.equal(bad.error, "invalid_fields");
  console.log("4. request-featured ok");
}

// ── 5. roast: mint + public page, PII-stripped ──────────────────────
{
  const review = {
    score: 62, verdict: "Solid engineer, weak keywords.",
    strengths: ["Quantified impact", "Clear seniority"],
    gaps: ["Missing Kubernetes keyword", "No metrics in latest role"],
    missing_keywords: ["k8s"],
  };
  await db.prepare("INSERT INTO user_resume (user_id, filename, text, llm_review_json, is_active) VALUES (?, 'r.pdf', ?, ?, 1)")
    .bind(userId, "John Doe\njohn@example.com\n555-1234\nSenior Engineer at Acme…", JSON.stringify(review)).run();

  const minted = await readJson(await roastPost({ request: authed("POST", "/api/me/roast"), env }));
  assert.ok(minted.ok && minted.url.includes("/roast/"), "roast minted: " + minted.url);

  const stored = await db.prepare("SELECT * FROM roast WHERE public_id = ?").bind(minted.public_id).first();
  const blob = JSON.stringify(stored);
  assert.ok(!blob.includes("John Doe") && !blob.includes("john@example.com") && !blob.includes("555-1234"), "no PII stored");

  const page = await roastPage({ env, params: { id: minted.public_id } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('property="og:title"') && html.includes("62/100"), "OG tags + score render");
  assert.ok(!html.includes("John Doe"), "no PII on page");

  const missing = await roastPage({ env, params: { id: "nope-not-real" } });
  assert.equal(missing.status, 404);
  console.log("5. roast ok");
}

// ── 6. referral loop ────────────────────────────────────────────────
{
  // referrer gets a code via the API (backfill path)
  const ref1 = await readJson(await referralGet({ request: authed("GET", "/api/me/referral"), env }));
  assert.ok(/^MJ-[A-Z2-9]{6}$/.test(ref1.code), "code format: " + ref1.code);
  assert.ok(ref1.url.includes("ref=" + ref1.code), "invite url carries ref");

  // referred signup with the code
  const signupRes = await signupPost({
    request: new Request(`https://x/api/auth/signup?ref=${ref1.code}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "friend@example.com", password: "password123", display_name: "Friend", newsletter_opt_in: true }),
    }), env,
  });
  const sj = await readJson(signupRes);
  assert.ok(sj.ok && sj.user.referred, "referred signup accepted");

  const referrer = await db.prepare("SELECT chat_bonus_credits FROM app_user WHERE id = ?").bind(userId).first();
  const referred = await db.prepare("SELECT chat_bonus_credits, referred_by_code FROM app_user WHERE email = ?").bind("friend@example.com").first();
  assert.equal(referrer.chat_bonus_credits, 10, "referrer +10");
  assert.equal(referred.chat_bonus_credits, 10, "referred +10");
  assert.equal(referred.referred_by_code, ref1.code);
  const ev = await db.prepare("SELECT * FROM referral_event WHERE referrer_user_id = ?").bind(userId).first();
  assert.ok(ev, "referral_event logged");

  // bogus code → signup still works, no credit
  const badSignup = await signupPost({
    request: new Request("https://x/api/auth/signup?ref=MJ-BOGUS1", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "friend2@example.com", password: "password123", newsletter_opt_in: true }),
    }), env,
  });
  assert.ok((await readJson(badSignup)).ok, "bogus ref doesn't block signup");
  console.log("6. referral ok");
}

// ── 7. chat bonus burn ──────────────────────────────────────────────
{
  // exhaust the 30/day member cap
  for (let i = 0; i < 30; i++) {
    await db.prepare("INSERT INTO anon_free_run (ip_hash, kind) VALUES (?, 'chat')").bind(`user:${userId}`).run();
  }
  const before = await db.prepare("SELECT chat_bonus_credits FROM app_user WHERE id = ?").bind(userId).first();
  assert.equal(before.chat_bonus_credits, 10);

  const res = await handleChat(authed("POST", "/chat", { message: "remote python jobs" }), env);
  const j = await readJson(res);
  assert.ok(j.ok && j.bonus_used === true, "bonus credit burned instead of 429: " + JSON.stringify(j).slice(0, 200));
  const after = await db.prepare("SELECT chat_bonus_credits FROM app_user WHERE id = ?").bind(userId).first();
  assert.equal(after.chat_bonus_credits, 9, "one credit consumed");

  // drain credits → next message 429s
  await db.prepare("UPDATE app_user SET chat_bonus_credits = 0 WHERE id = ?").bind(userId).run();
  const res2 = await handleChat(authed("POST", "/chat", { message: "more jobs" }), env);
  assert.equal(res2.status, 429, "no credits → 429");
  console.log("7. chat bonus ok");
}

// ── 8. SEO surfaces ─────────────────────────────────────────────────
{
  // JSON-LD validity (required + recommended fields)
  const ld = jobPostingJsonLd(
    { id: jobId1, title: "Senior Software Engineer", location: "New York, NY", employment_type: "full_time", salary_min: 150000, salary_max: 200000, salary_currency: "USD", posted_at: "2026-09-10", first_seen_at: "2026-09-10 12:00:00", description_text: "Build things.", remote_policy: "hybrid", company_name: "Acme Corp" },
    { name: "Acme Corp" }
  );
  for (const k of ["title", "description", "datePosted", "hiringOrganization", "jobLocation", "employmentType", "baseSalary", "validThrough", "identifier"]) {
    assert.ok(ld[k] !== undefined && ld[k] !== null, `JSON-LD has ${k}`);
  }
  assert.equal(ld["@type"], "JobPosting");
  assert.ok(ld.jobLocation.address.addressLocality === "New York");

  // detail page
  const detail = await jobPage({ request: new Request(`https://jobs.mehyar.us/job/${jobId1}`), env, params: { id: String(jobId1) } });
  assert.equal(detail.status, 200);
  const dHtml = await detail.text();
  assert.ok(dHtml.includes('application/ld+json') && dHtml.includes('"@type":"JobPosting"'), "detail carries JSON-LD");
  assert.ok(dHtml.includes("Senior Software Engineer") && dHtml.includes("Acme Corp"));
  const d404 = await jobPage({ request: new Request("https://jobs.mehyar.us/job/999999"), env, params: { id: "999999" } });
  assert.equal(d404.status, 404);

  // listing page: title + city
  const list = await seoPage({ request: new Request("https://jobs.mehyar.us/jobs/senior-software-engineer/new-york-ny"), env, params: { seo: ["senior-software-engineer", "new-york-ny"] } });
  assert.equal(list.status, 200);
  const lHtml = await list.text();
  assert.ok(lHtml.includes("/job/") && lHtml.includes("Acme Corp"), "listing links to detail pages");
  assert.ok(lHtml.includes("open") && lHtml.includes("Senior Software Engineer"), "unique intro copy");

  // title-only page
  const list2 = await seoPage({ request: new Request("https://jobs.mehyar.us/jobs/junior-nurse"), env, params: { seo: ["junior-nurse"] } });
  assert.equal((await list2.text()).includes("Junior Nurse"), true);

  // empty query → unique intro differs per page
  const la = await (await seoPage({ request: new Request("https://x/jobs/senior-software-engineer/austin-tx"), env, params: { seo: ["senior-software-engineer", "austin-tx"] } })).text();
  assert.ok(la.includes("Austin") && !la.includes("New York, NY</h1>"), "city pages differ");

  // /jobs (no segments) falls through to the SPA
  const spa = await seoPage({
    request: new Request("https://jobs.mehyar.us/jobs"), env, params: { seo: [] },
  });
  // no ASSETS binding in test → 404 expected; with ASSETS it would proxy
  assert.equal(spa.status, 404);

  // hub
  const hub = await seoPage({ request: new Request("https://jobs.mehyar.us/jobs/browse"), env, params: { seo: ["browse"] } });
  assert.equal(hub.status, 200);
  assert.ok((await hub.text()).includes("/jobs/"));

  // sitemap index + chunks
  const idx = await sitemapIndex({ env });
  const idxXml = await idx.text();
  assert.ok(idxXml.includes("/sitemap/jobs-1.xml") && idxXml.includes("/sitemap/seo.xml"), "index lists chunks");

  const c1 = await sitemapChunk({ env, params: { chunk: "jobs-1.xml" } });  // real URLs carry the .xml suffix
  const c1Xml = await c1.text();
  assert.ok(c1Xml.includes(`/job/${jobId1}-`), "jobs chunk lists detail URLs");

  const seo = await sitemapChunk({ env, params: { chunk: "seo" } });
  const seoXml = await seo.text();
  assert.ok(seoXml.includes("/jobs/browse"), "seo chunk lists browse hub");

  // robots
  const rb = await robots({});
  const rbTxt = await rb.text();
  assert.ok(rbTxt.includes("Sitemap: https://jobs.mehyar.us/sitemap.xml") && rbTxt.includes("Disallow: /api/"));
  console.log("8. SEO surfaces ok");
}

console.log("\nAll growth-engine tests passed ✅");
// NOTE: node:sqlite segfaults on teardown on Node 24 — exit explicitly.
process.exit(0);
