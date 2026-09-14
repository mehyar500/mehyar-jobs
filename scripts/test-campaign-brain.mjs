// scripts/test-campaign-brain.mjs
// Campaign brain tests (D1 shim):
//   1. Migration 0021 applies; campaign_plan table exists.
//   2. validatePlan: good plan passes; bad plans rejected (weights sum,
//      unknown/negative/missing skeleton ids, bad segment_focus,
//      subject copy-rule violations, short reasoning).
//   3. Product override enforcement: cooldown-violating LLM pick falls back
//      to getProductOfDay; unapproved product rejected; valid pick accepted.
//   4. EMAIL_LIVE absence: brain + plan modules never reference it.
//   5. Sender fallback: no plan row -> resolvePlanForSend null and
//      queueDailySends runs the deterministic path (plan:null).
//   6. Sender plan path: plan row -> product woven + meta tagged +
//      subject tweak applied + segment focus reorders the list.
//   7. buildProductStats aggregation math (times featured, clicks, CTR).
//   8. runCampaignBrain with a fake AI writes one row; a second run skips
//      (idempotent); extractJson tolerates fenced output.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { ensureSchema } from "../functions/_shared/db.js";
import {
  validatePlan, validateProductOverride, resolveProductForPlan,
  readPlanRow, resolvePlanForSend, chooseSkeletonIdx, applySegmentFocus,
} from "../functions/_shared/campaignPlan.js";
import { getProductOfDay } from "../functions/_shared/productCatalog.js";
import { queueDailySends, digestSubject } from "../functions/_shared/emailFunnel.js";
import { buildProductStats } from "../functions/api/admin/email/product-stats.js";
import { runCampaignBrain, etDate, addDays, extractJson, deterministicFallbackPlan, brainWindowOpen } from "../scanner-worker/src/campaignBrain.js";

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

const env = { JOBS_DB: new D1Shim() };
await ensureSchema(env);
const db = env.JOBS_DB;

const GOOD_PLAN = {
  skeleton_weights: { 0: 0.2, 1: 0.35, 2: 0.1, 3: 0.1, 4: 0.1, 5: 0.15 },
  product_override_slug: "logitech-c920s",
  subject_tweaks: [{ skeleton_id: 1, subject: "Your matches today, picked by a human" }],
  segment_focus: "engaged_first",
  reasoning: "Opens are healthy so the digest anchor keeps the lead weight, with value-only earning replies for inbox placement. The webcam gets the override: low recent clicks and it is outside its cooldown.",
};

// ── 1. migration 0021 ──────────────────────────────────────────────
{
  const r = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaign_plan'").first();
  assert.ok(r, "campaign_plan table exists");
  console.log("1. migration 0021 ok");
}

// ── 2. validatePlan ────────────────────────────────────────────────
{
  assert.ok(validatePlan(GOOD_PLAN).ok, "good plan validates");
  const bad = (patch, why) => {
    const p = JSON.parse(JSON.stringify(GOOD_PLAN));
    patch(p);
    const v = validatePlan(p);
    assert.ok(!v.ok, `rejected: ${why}`);
  };
  bad((p) => { p.skeleton_weights = { 0: 0.2, 1: 0.2, 2: 0.1, 3: 0.1, 4: 0.1, 5: 0 }; }, "weights sum 0.7");
  bad((p) => { p.skeleton_weights = { 0: 0.5, 1: 0.5, 7: 0 }; }, "unknown skeleton id + missing ids");
  bad((p) => { p.skeleton_weights["1"] = -0.1; p.skeleton_weights["0"] = 1.1; }, "negative weight");
  bad((p) => { p.skeleton_weights = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }; }, "all zero");
  bad((p) => { p.segment_focus = "spray_and_pray"; }, "bad segment_focus");
  bad((p) => { p.subject_tweaks = [{ skeleton_id: 1, subject: "Free jobs inside!" }]; }, "subject with free + !");
  bad((p) => { p.subject_tweaks = [{ skeleton_id: 9, subject: "fine subject" }]; }, "tweak bad skeleton_id");
  bad((p) => { p.reasoning = "too short"; }, "short reasoning");
  bad((p) => { p.product_override_slug = ""; }, "empty override slug");
  assert.ok(!validatePlan(null).ok, "null rejected");
  console.log("2. validatePlan good + bad ok");
}

// ── 3. product override enforcement ────────────────────────────────
{
  const today = "2026-09-14";
  // logitech-c920s was just featured -> cooldown violation.
  await db.prepare("UPDATE product_slot SET last_featured_on = ? WHERE slug = 'logitech-c920s'").bind("2026-09-13").run();
  const v = await validateProductOverride(db, today, "logitech-c920s");
  assert.ok(!v.ok && v.reason === "cooldown", `cooldown rejected (got ${v.reason})`);

  const r = await resolveProductForPlan(db, today, "logitech-c920s");
  assert.equal(r.source, "deterministic_fallback", "violating override falls back");
  assert.ok(r.product && r.product.slug !== "logitech-c920s", "fallback is a different product");
  assert.equal(r.rejected, "cooldown");

  const unapproved = await validateProductOverride(db, today, "yotru");
  assert.ok(!unapproved.ok && (unapproved.reason === "inactive" || unapproved.reason === "unapproved"), `unapproved+inactive rejected (got ${unapproved.reason})`);
  const unknown = await validateProductOverride(db, today, "nope-not-real");
  assert.ok(!unknown.ok && unknown.reason === "unknown_slug", "unknown slug rejected");

  // A valid pick passes through untouched.
  await db.prepare("UPDATE product_slot SET last_featured_on = NULL WHERE slug = 'screenbar'").run();
  const okv = await validateProductOverride(db, today, "screenbar");
  assert.ok(okv.ok && okv.product.slug === "screenbar", "valid override accepted");
  const rok = await resolveProductForPlan(db, today, "screenbar");
  assert.equal(rok.source, "llm_override");
  assert.equal(rok.product.slug, "screenbar");
  console.log("3. cooldown + eligibility enforcement ok");
}

// ── 4. EMAIL_LIVE absence ──────────────────────────────────────────
{
  for (const f of ["scanner-worker/src/campaignBrain.js", "functions/_shared/campaignPlan.js"]) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.ok(!src.includes("EMAIL_LIVE"), `${f} must never reference the live-send switch`);
    assert.ok(!/sendEmailViaEsp|EMAIL\.send|email\/send|smtp\/email/.test(src), `${f} must have no send path`);
  }
  console.log("4. EMAIL_LIVE absence ok");
}

// ── helpers for sender tests ───────────────────────────────────────
async function seedContact(email, band, variantBand = "high") {
  await db.prepare(
    "INSERT INTO email_contact (email, status, source, provider, sent_count) VALUES (?, 'active', 'legacy', 'gmail', 0)"
  ).bind(email).run();
  const c = await db.prepare("SELECT id FROM email_contact WHERE email = ?").bind(email).first();
  await db.prepare(
    "INSERT INTO contact_engagement (contact_id, engagement_band, last_click_at) VALUES (?, ?, datetime('now'))"
  ).bind(c.id, band).run();
  return c.id;
}
async function seedGate() {
  await db.prepare("INSERT INTO seed_test (template, inbox_pct, spam_pct) VALUES ('daily_digest', 95, 1)").run();
}

// ── 5. sender fallback (no plan row) ───────────────────────────────
{
  await seedGate();
  await seedContact("fallback@example.com", "high");
  const now = new Date("2026-09-14T12:00:00Z");
  const none = await resolvePlanForSend(db, "2026-09-14");
  assert.equal(none, null, "no plan row -> null");
  const res = await queueDailySends(db, env, { live: false, now, appUrl: "https://jobs.mehyar.us" });
  assert.ok(res.ok, "sender runs without a plan");
  assert.equal(res.plan, null, "result reports plan:null");
  const logged = await db.prepare("SELECT meta_json FROM email_send ORDER BY id DESC LIMIT 1").first();
  const meta = JSON.parse(logged.meta_json);
  assert.ok(!("plan" in meta), "fallback sends carry no plan tag");
  // subject tweaks default to the built-in pool only
  const s1 = digestSubject({ email: "x@y.z", dateStr: "2026-09-14", extraSubjects: [] });
  assert.ok(typeof s1 === "string" && s1.length > 0);
  console.log("5. sender fallback ok");
}

// ── 6. sender plan path ────────────────────────────────────────────
{
  const today = "2026-09-15";
  await seedContact("plan-engaged@example.com", "high");
  await seedContact("plan-atrisk@example.com", "at_risk");
  const plan = {
    ...GOOD_PLAN,
    product_override_slug: "screenbar",
    subject_tweaks: [{ skeleton_id: 1, subject: "Brain-picked subject for today" }],
    segment_focus: "winback_heavy",
  };
  const stored = { ...plan, product_slug: "screenbar", product_source: "llm_override", product_rejected: null };
  await db.prepare(
    "INSERT OR REPLACE INTO campaign_plan (plan_date, plan_json, reasoning_text, model) VALUES (?, ?, ?, ?)"
  ).bind(today, JSON.stringify(stored), plan.reasoning, "@cf/meta/llama-3.1-8b-instruct-fp8").run();

  const resolved = await resolvePlanForSend(db, today);
  assert.ok(resolved && resolved.product && resolved.product.slug === "screenbar", "plan product resolved");

  const before = await db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM email_send").first();

  const res = await queueDailySends(db, env, { live: false, now: new Date(`${today}T12:00:00Z`), appUrl: "https://jobs.mehyar.us" });
  assert.ok(res.ok, "sender runs with a plan");
  assert.equal(res.plan.product_slug, "screenbar", "result reports the plan product");
  assert.equal(res.plan.segment_focus, "winback_heavy");

  const rows = await db.prepare("SELECT contact_id, meta_json FROM email_send WHERE id > ? ORDER BY id").bind(before.m).all();
  assert.ok(rows.results.length >= 2, "both contacts queued");
  for (const row of rows.results) {
    const meta = JSON.parse(row.meta_json);
    assert.equal(meta.plan, 1, "plan-driven sends are tagged");
  }
  // segment focus: winback_heavy puts the at-risk contact first.
  const first = rows.results[0];
  const firstEmail = await db.prepare("SELECT email FROM email_contact WHERE id = ?").bind(first.contact_id).first();
  assert.equal(firstEmail.email, "plan-atrisk@example.com", "winback_heavy reorders the list");

  // product featured stamp advances (plan path stamps after sends).
  const feat = await db.prepare("SELECT last_featured_on FROM product_slot WHERE slug = 'screenbar'").first();
  assert.equal(feat.last_featured_on, today, "plan product marked featured");

  // chooseSkeletonIdx determinism + guardrail shape.
  const a = chooseSkeletonIdx(GOOD_PLAN.skeleton_weights, "a@b.c", today);
  const b = chooseSkeletonIdx(GOOD_PLAN.skeleton_weights, "a@b.c", today);
  assert.equal(a, b, "skeleton pick is stable per recipient per day");
  assert.ok([0, 1, 2, 3, 4].includes(a), "pick is a known skeleton");

  // applySegmentFocus is a stable reorder.
  const l = [{ band: "high", variant: "standard" }, { band: "at_risk", variant: "winback" }];
  const re = applySegmentFocus(l, "winback_heavy");
  assert.equal(re[0].band, "at_risk");
  assert.deepEqual(applySegmentFocus(l, "balanced"), l, "balanced keeps order");
  console.log("6. sender plan path ok");
}

// ── 7. product-stats aggregation ───────────────────────────────────
{
  const c = await db.prepare("SELECT id FROM email_contact WHERE email = 'plan-engaged@example.com'").first();
  const ins = (kind, slug, day) => db.prepare(
    "INSERT INTO email_event (contact_id, kind, meta_json, created_at) VALUES (?, ?, ?, ?)"
  ).bind(c.id, kind, JSON.stringify({ product: slug }), `${day} 12:00:00`).run();
  await ins("open", "screenbar", "2026-09-15");
  await ins("click", "screenbar", "2026-09-15");
  await ins("click", "screenbar", "2026-09-14");
  await ins("open", "logitech-c920s", "2026-09-13");

  const stats = await buildProductStats(db);
  assert.ok(stats.ok);
  const sb = stats.products.find((p) => p.slug === "screenbar");
  assert.ok(sb, "screenbar row present");
  assert.equal(sb.events, 3, "screenbar events");
  assert.equal(sb.clicks, 2, "screenbar clicks");
  assert.equal(sb.times_featured, 1, "screenbar featured on one plan day");
  assert.equal(sb.ctr, Math.round((2 / 3) * 1e6) / 1e6, "CTR = clicks/events");
  assert.equal(sb.last_seen, "2026-09-15");
  assert.equal(sb.active, true);
  const c920 = stats.products.find((p) => p.slug === "logitech-c920s");
  assert.equal(c920.events, 1);
  assert.equal(c920.ctr, 0, "no clicks -> ctr 0");
  const yotru = stats.products.find((p) => p.slug === "yotru");
  assert.equal(yotru.active, false, "catalog status carried through");
  assert.equal(yotru.events, 0);
  console.log("7. product-stats math ok");
}

// ── 8. runCampaignBrain with a fake AI ──────────────────────────────
{
  assert.equal(typeof etDate(new Date("2026-09-14T10:30:00Z")), "string");
  assert.equal(etDate(new Date("2026-09-14T10:30:00Z")), "2026-09-14", "10:30 UTC = 06:30 EDT");
  assert.equal(etDate(new Date("2026-12-14T11:30:00Z")), "2026-12-14", "11:30 UTC = 06:30 EST");
  assert.equal(addDays("2026-09-14", -1), "2026-09-13");

  // Cron window gate: the plan must be written at ~06:30 ET, never 05:30.
  assert.equal(brainWindowOpen(new Date("2026-09-14T10:30:00Z")), true, "06:30 EDT -> open");
  assert.equal(brainWindowOpen(new Date("2026-09-14T11:30:00Z")), true, "07:30 EDT -> open (idempotent skip)");
  assert.equal(brainWindowOpen(new Date("2026-12-14T10:30:00Z")), false, "05:30 EST -> dormant");
  assert.equal(brainWindowOpen(new Date("2026-12-14T11:30:00Z")), true, "06:30 EST -> open");

  const fenced = '```json\n{"a": 1}\n```';
  assert.deepEqual(extractJson(fenced), { a: 1 }, "fenced JSON extracted");
  const v = validatePlan(deterministicFallbackPlan());
  assert.ok(v.ok, "deterministic fallback always validates");

  const fakeAi = {
    run: async () => JSON.stringify({
      skeleton_weights: { 0: 0.25, 1: 0.3, 2: 0.1, 3: 0.1, 4: 0.1, 5: 0.15 },
      product_override_slug: "ember-mug",
      subject_tweaks: [{ skeleton_id: 4, subject: "One filter trick worth 30 seconds" }],
      segment_focus: "balanced",
      reasoning: "List is mostly fresh so the mix stays balanced across skeletons. The ember mug is outside its cooldown and has no recent clicks, so it gets today's override.",
    }),
  };
  const benv = { JOBS_DB: new D1Shim() };
  await ensureSchema(benv);
  const bdb = benv.JOBS_DB;
  await bdb.prepare("INSERT INTO seed_test (template, inbox_pct, spam_pct) VALUES ('daily_digest', 95, 1)").run();

  const first = await runCampaignBrain({ ...benv, AI: fakeAi });
  assert.ok(first.ok && !first.skipped, "brain writes a plan");
  assert.equal(first.product_slug, "ember-mug");
  assert.equal(first.product_source, "llm_override");
  const row = await readPlanRow(bdb, etDate());
  assert.ok(row && row.plan.product_slug === "ember-mug", "row readable via readPlanRow");
  assert.ok(row.reasoning_text.length > 20);

  const second = await runCampaignBrain({ ...benv, AI: null });
  assert.ok(second.ok && second.skipped, "second run is idempotent (no AI call)");

  // AI failure -> deterministic fallback still writes a valid row.
  const cenv = { JOBS_DB: new D1Shim(), AI: { run: async () => { throw new Error("boom"); } } };
  await ensureSchema(cenv);
  const cres = await runCampaignBrain(cenv);
  assert.ok(cres.ok && cres.fallback, "AI failure falls back deterministically");
  const crow = await readPlanRow(cenv.JOBS_DB, etDate());
  assert.ok(crow && validatePlan(crow.plan).ok, "fallback row validates");
  assert.ok(crow.model.includes("deterministic-fallback"));
  console.log("8. runCampaignBrain ok");
}

console.log("ALL CAMPAIGN BRAIN TESTS PASSED");
process.exit(0);
