// scripts/test-email-funnel.mjs
// Email warm-up funnel tests (D1 shim):
//   1. Migration 0017 applies; fib_gate seeded at level 5.
//   2. providerOf classification.
//   3. classifyBand boundaries.
//   4. Webhook ingestion: open/click engage; MPP-suspect opens don't band;
//      hard_bounce/complaint/unsubscribe suppress instantly.
//   5. Daily list: core kept, at-risk -> winback variant, inactive excluded,
//      sent-today + weekly caps enforced, total <= Fibonacci level.
//  5c. Legacy reserve: engaged core + winback capped at (cap - reserve),
//      fresh fills the remainder; LEGACY_RESERVE_FRAC override respected.
//   6. Provider pacing: gmail first, outlook capped at 25% + sendLate.
//   7. Prune: 5 sends no engagement -> sunset; winbacks; then suppressed.
//   8. Gate: advance on green, hold on yellow, pause on critical, hold_until respected.
//   9. Pre-send seed-test gate blocks/passes correctly.
//  10. Personalization: user fits top-3 + resume score; legacy role/state
//      fallback; rendered copy never guarantees interviews.
//  11. queueDailySends dry-run logs rows, touches no ESP.
//  12. Subject spintax: deterministic per recipient per day, rotates across
//      recipients, obeys copy rules (no FREE, no shouty caps/punctuation).
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureSchema } from "../functions/_shared/db.js";
import {
  FIB_LEVELS, GATE, providerOf, classifyBand, daysAgo,
  recordEmailEvent, recomputeBand, ensureEngagementRow,
  getGate, evaluateGate, buildDailyList, pruneContacts,
  preSendGateCheck, recordSeedTest,
  personalizeForContact, renderDigestEmail, digestSubject,
  importEmailContacts, queueDailySends, logEmailSend,
} from "../functions/_shared/emailFunnel.js";
import { onRequestPost as webhookPost } from "../functions/api/email/webhook.js";

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

const env = { JOBS_DB: new D1Shim(), MESC_JWT_SECRET: "test-secret-1234567890abcdef" };
const fetchCalls = [];
globalThis.fetch = async (url) => { fetchCalls.push(String(url)); return { ok: true, json: async () => ({}) }; };

await ensureSchema(env);
const db = env.JOBS_DB;
const now = new Date();

// ── 1. migration 0017 ──────────────────────────────────────────────
{
  for (const t of ["email_contact", "contact_engagement", "email_send", "email_event", "fib_gate", "seed_test"]) {
    const r = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(t).first();
    assert.ok(r, `table ${t} exists`);
  }
  const g = await db.prepare("SELECT level, status FROM fib_gate WHERE id = 1").first();
  assert.equal(g.level, 5, "gate starts at level 5");
  assert.equal(g.status, "ramping");
  assert.deepEqual(FIB_LEVELS.slice(0, 6), [5, 10, 15, 25, 40, 65], "fibonacci levels");
  console.log("1. migration 0017 + fib levels ok");
}

// ── 2. provider classification ─────────────────────────────────────
{
  assert.equal(providerOf("a@gmail.com"), "gmail");
  assert.equal(providerOf("a@googlemail.com"), "gmail");
  assert.equal(providerOf("a@outlook.com"), "outlook");
  assert.equal(providerOf("a@hotmail.com"), "outlook");
  assert.equal(providerOf("a@live.com"), "outlook");
  assert.equal(providerOf("a@yahoo.com"), "yahoo");
  assert.equal(providerOf("a@icloud.com"), "apple");
  assert.equal(providerOf("a@me.com"), "apple");
  assert.equal(providerOf("a@corp.example"), "other");
  console.log("2. providerOf ok");
}

// ── 3. band classification ─────────────────────────────────────────
{
  assert.equal(classifyBand({ lastClickAt: daysAgo(5, now), now }), "high");
  assert.equal(classifyBand({ lastClickAt: daysAgo(45, now), now }), "moderate");
  assert.equal(classifyBand({ lastOpenAt: daysAgo(10, now), now }), "moderate");
  assert.equal(classifyBand({ lastClickAt: daysAgo(120, now), now }), "at_risk");
  assert.equal(classifyBand({ lastOpenAt: daysAgo(60, now), now }), "at_risk");
  assert.equal(classifyBand({ lastClickAt: daysAgo(400, now), lastOpenAt: daysAgo(300, now), now }), "inactive");
  assert.equal(classifyBand({ now }), "inactive");
  console.log("3. classifyBand ok");
}

// seed contacts
async function addContact(email, { status = "pending", source = "legacy", band = "fresh", extra = {} } = {}) {
  const r = await db.prepare(
    `INSERT INTO email_contact (email, status, source, first_name, state, role_title, provider)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(email.toLowerCase(), status, source, extra.firstName || "Test", extra.state || "NY",
    extra.roleTitle || "Backend Engineer", providerOf(email)).run();
  const id = r.meta.last_row_id;
  await ensureEngagementRow(db, id);
  if (band !== "fresh") {
    await db.prepare("UPDATE contact_engagement SET engagement_band = ? WHERE contact_id = ?").bind(band, id).run();
  }
  if (extra.lastClickAt) {
    await db.prepare("UPDATE contact_engagement SET last_click_at = ?, clicks = 1 WHERE contact_id = ?").bind(extra.lastClickAt, id).run();
    await recomputeBand(db, id, now);
  }
  return id;
}

// ── 4. webhook ingestion ───────────────────────────────────────────
{
  const id = await addContact("engaged@example.com", { status: "active", band: "high" });
  let res = await recordEmailEvent(db, "engaged@example.com", "open", {});
  assert.equal(res.action, "engaged");
  let e = await db.prepare("SELECT opens, last_open_at FROM contact_engagement WHERE contact_id = ?").bind(id).first();
  assert.equal(e.opens, 1);
  assert.ok(e.last_open_at, "real open sets last_open_at");

  res = await recordEmailEvent(db, "engaged@example.com", "open", { mppSuspect: true });
  assert.equal(res.action, "mpp_open");
  e = await db.prepare("SELECT opens, mpp_suspect_opens, last_open_at FROM contact_engagement WHERE contact_id = ?").bind(id).first();
  assert.equal(e.opens, 1, "MPP open does not increment real opens");
  assert.equal(e.mpp_suspect_opens, 1);

  // MPP-only contact never promotes to high via opens
  const mppId = await addContact("mpp@icloud.com", { status: "active", band: "inactive" });
  await recordEmailEvent(db, "mpp@icloud.com", "opened", { mppSuspect: true });
  await recordEmailEvent(db, "mpp@icloud.com", "opened", { mppSuspect: true });
  e = await db.prepare("SELECT engagement_band, last_open_at FROM contact_engagement WHERE contact_id = ?").bind(mppId).first();
  assert.equal(e.engagement_band, "inactive", "MPP opens never promote band");
  assert.equal(e.last_open_at, null);

  res = await recordEmailEvent(db, "engaged@example.com", "click", {});
  assert.equal(res.action, "engaged");
  e = await db.prepare("SELECT clicks, last_click_at, sends_since_engagement FROM contact_engagement WHERE contact_id = ?").bind(id).first();
  assert.equal(e.clicks, 1);
  assert.equal(e.sends_since_engagement, 0, "click resets no-engagement counter");

  // instant suppression paths
  const bId = await addContact("bounce@example.com", { status: "active", band: "high" });
  res = await recordEmailEvent(db, "bounce@example.com", "hard_bounce", {});
  assert.equal(res.action, "suppressed");
  let c = await db.prepare("SELECT status FROM email_contact WHERE id = ?").bind(bId).first();
  assert.equal(c.status, "suppressed");

  const cId = await addContact("complainer@example.com", { status: "active", band: "high" });
  res = await recordEmailEvent(db, "complainer@example.com", "spam", {});
  assert.equal(res.action, "suppressed");

  const uId = await addContact("leaver@example.com", { status: "active", band: "high" });
  res = await recordEmailEvent(db, "leaver@example.com", "unsubscribed", {});
  assert.equal(res.action, "opted_out");
  c = await db.prepare("SELECT status FROM email_contact WHERE id = ?").bind(uId).first();
  assert.equal(c.status, "opted_out");

  // webhook endpoint normalizes provider event names
  const wId = await addContact("hook@example.com", { status: "active", band: "high" });
  const wres = await webhookPost({ request: new Request("https://x/api/email/webhook", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "brevo", email: "hook@example.com", event: "opened" }),
  }), env });
  assert.equal(wres.status, 200);
  const wj = JSON.parse(await wres.text());
  assert.equal(wj.action, "engaged");
  void wId;
  console.log("4. webhook ingestion + instant suppression ok");
}

// ── 5. daily list composition ──────────────────────────────────────
{
  await db.prepare("DELETE FROM email_contact").run();
  // core: high + moderate actives
  await addContact("high1@gmail.com", { status: "active", band: "high", extra: { lastClickAt: daysAgo(3, now) } });
  await addContact("mod1@gmail.com", { status: "active", band: "moderate", extra: { lastClickAt: daysAgo(50, now) } });
  // at-risk -> winback variant
  await addContact("risk1@gmail.com", { status: "active", band: "at_risk", extra: { lastClickAt: daysAgo(120, now) } });
  // inactive excluded
  await addContact("dead1@gmail.com", { status: "active", band: "inactive", extra: { lastClickAt: daysAgo(400, now) } });
  // fresh legacy slice (newest first)
  await addContact("fresh1@gmail.com", { status: "pending" });
  await addContact("fresh2@gmail.com", { status: "pending" });

  const plan = await buildDailyList(db, { now, limit: 5 });
  assert.equal(plan.cap, 5);
  const emails = plan.list.map((l) => l.email);
  assert.ok(emails.includes("high1@gmail.com"), "high kept");
  assert.ok(emails.includes("mod1@gmail.com"), "moderate kept");
  assert.ok(!emails.includes("dead1@gmail.com"), "inactive excluded");
  const risk = plan.list.find((l) => l.email === "risk1@gmail.com");
  assert.ok(risk, "at-risk included");
  assert.equal(risk.variant, "winback", "at-risk gets winback variant");
  const freshCount = plan.list.filter((l) => l.band === "fresh").length;
  assert.equal(freshCount, 2, "fresh slice fills remaining cap");
  assert.equal(plan.list.length, 5, "cap respected");
  assert.ok(plan.list.length <= plan.cap, "total never exceeds Fibonacci level");
  assert.deepEqual(plan.counts, { core: 2, winback: 1, fresh: 2, skipped_outlook_cap: 0, reserve: 2 });
  console.log("5. daily list composition ok");
}

// ── 5b. sent-today + weekly caps ───────────────────────────────────
{
  const id = await addContact("capped@gmail.com", { status: "active", band: "high", extra: { lastClickAt: daysAgo(3, now) } });
  await db.prepare("UPDATE email_contact SET last_sent_at = ?, week_sent_count = 4 WHERE id = ?").bind(now.toISOString(), id).run();
  const plan = await buildDailyList(db, { now, limit: 50 });
  assert.ok(!plan.list.some((l) => l.email === "capped@gmail.com"), "sent-today + weekly cap excluded");

  // super-engager (clicked <7d) exempt from weekly cap
  const se = await addContact("super@gmail.com", { status: "active", band: "high", extra: { lastClickAt: daysAgo(2, now) } });
  await db.prepare("UPDATE email_contact SET week_sent_count = 4, last_sent_at = ? WHERE id = ?").bind(daysAgo(1, now), se).run();
  const plan2 = await buildDailyList(db, { now, limit: 50 });
  assert.ok(plan2.list.some((l) => l.email === "super@gmail.com"), "super-engager exempt from weekly cap");
  console.log("5b. frequency caps ok");
}

// ── 5c. Fibonacci cap + legacy reserve ──────────────────────────────
{
  await db.prepare("DELETE FROM email_contact").run();
  // 8 engaged actives + 8 fresh pending, cap 10
  for (let i = 0; i < 8; i++) await addContact(`e${i}@gmail.com`, { status: "active", band: "high", extra: { lastClickAt: daysAgo(2, now) } });
  for (let i = 0; i < 8; i++) await addContact(`f${i}@gmail.com`, { status: "pending" });

  const plan = await buildDailyList(db, { now, limit: 10, env: {} });
  assert.equal(plan.counts.reserve, 5, "default 50% reserve of cap 10");
  assert.ok(plan.counts.core + plan.counts.winback <= 5, "engaged capped at cap - reserve");
  assert.equal(plan.counts.fresh, 5, "fresh fills remainder up to reserve");
  assert.ok(plan.list.length <= 10, "total never exceeds Fibonacci level");

  // env override 0 -> no reserve, engaged takes the whole cap
  const plan0 = await buildDailyList(db, { now, limit: 10, env: { LEGACY_RESERVE_FRAC: "0" } });
  assert.equal(plan0.counts.reserve, 0);
  assert.equal(plan0.counts.core, 8, "no reserve -> all 8 engaged selected");
  assert.equal(plan0.counts.fresh, 2, "fresh fills only leftover");
  assert.ok(plan0.list.length <= 10);

  // env override 1 -> everything reserved for fresh
  const plan1 = await buildDailyList(db, { now, limit: 10, env: { LEGACY_RESERVE_FRAC: "1" } });
  assert.equal(plan1.counts.reserve, 10);
  assert.equal(plan1.counts.core, 0, "full reserve -> no engaged selected");
  assert.equal(plan1.counts.fresh, 8, "fresh takes all available up to cap");
  assert.ok(plan1.list.length <= 10);

  // invalid env falls back to default
  const planBad = await buildDailyList(db, { now, limit: 10, env: { LEGACY_RESERVE_FRAC: "junk" } });
  assert.equal(planBad.counts.reserve, 5, "invalid frac -> default 0.5");
  console.log("5c. fibonacci cap + legacy reserve ok");
}

// ── 6. provider pacing ─────────────────────────────────────────────
{
  // wipe and seed provider mix
  await db.prepare("DELETE FROM email_contact").run();
  for (let i = 0; i < 6; i++) await addContact(`g${i}@gmail.com`, { status: "active", band: "high", extra: { lastClickAt: daysAgo(2, now) } });
  for (let i = 0; i < 6; i++) await addContact(`o${i}@outlook.com`, { status: "active", band: "high", extra: { lastClickAt: daysAgo(2, now) } });
  const plan = await buildDailyList(db, { now, limit: 12 });
  const outlook = plan.list.filter((l) => l.provider === "outlook");
  assert.ok(outlook.length <= 3, `outlook capped at 25% (got ${outlook.length})`);
  assert.ok(outlook.every((l) => l.sendLate === true), "outlook marked sendLate");
  const firstNonGmail = plan.list.findIndex((l) => l.provider !== "gmail");
  const lastGmail = plan.list.map((l) => l.provider).lastIndexOf("gmail");
  assert.ok(firstNonGmail === -1 || lastGmail < firstNonGmail, "gmail first");
  console.log("6. provider pacing ok");
}

// ── 7. prune / sunset / winback ────────────────────────────────────
{
  await db.prepare("DELETE FROM email_contact").run();
  const stale = await addContact("stale@gmail.com", { status: "active", band: "inactive" });
  await db.prepare("UPDATE contact_engagement SET sends_since_engagement = 5 WHERE contact_id = ?").bind(stale).run();
  const p1 = await pruneContacts(db, { now });
  assert.equal(p1.sunsetted, 1, "5 sends no engagement -> sunset");
  let st = await db.prepare("SELECT status FROM email_contact WHERE id = ?").bind(stale).first();
  assert.equal(st.status, "sunset");

  // win-back due (no prior winback sent)
  const p2 = await pruneContacts(db, { now });
  assert.deepEqual(p2.winbackDue, [stale], "sunset contact due for winback");

  // after 3 winbacks -> suppressed
  await db.prepare("UPDATE contact_engagement SET winback_stage = 3 WHERE contact_id = ?").bind(stale).run();
  const p3 = await pruneContacts(db, { now });
  assert.equal(p3.suppressed, 1, "3 winbacks with no engagement -> suppressed");
  st = await db.prepare("SELECT status FROM email_contact WHERE id = ?").bind(stale).first();
  assert.equal(st.status, "suppressed");
  console.log("7. prune/sunset/winback ok");
}

// ── 8. Fibonacci gate state machine ────────────────────────────────
{
  await db.prepare("UPDATE fib_gate SET level_idx = 0, level = 5, status = 'ramping', hold_until = NULL WHERE id = 1").run();
  let r = await evaluateGate(db, { complaintPct: 0.02, bouncePct: 0.5, postmaster: "High", now });
  assert.equal(r.decision, "advanced");
  assert.equal(r.gate.level, 10, "green metrics advance 5 -> 10");
  assert.ok(r.gate.hold_until, "hold set after advance");

  // hold_until respected: immediate re-eval must not advance
  r = await evaluateGate(db, { complaintPct: 0.02, bouncePct: 0.5, postmaster: "High", now });
  assert.equal(r.decision, "holding");
  assert.equal(r.gate.level, 10);

  // yellow metrics -> hold
  const later = new Date(now.getTime() + 4 * 86400000);
  r = await evaluateGate(db, { complaintPct: 0.2, bouncePct: 1.0, postmaster: "Medium", now: later });
  assert.equal(r.decision, "holding");
  assert.equal(r.gate.level, 10, "no advance on yellow");

  // critical -> paused
  const later2 = new Date(now.getTime() + 8 * 86400000);
  r = await evaluateGate(db, { complaintPct: 0.5, bouncePct: 1.0, postmaster: "Medium", now: later2 });
  assert.equal(r.decision, "paused");
  assert.equal(r.gate.status, "paused");

  // paused gate -> zero cap
  const plan = await buildDailyList(db, { now: later2 });
  assert.equal(plan.cap, 0);
  assert.equal(plan.blocked, "gate_paused");

  // reset for later tests
  await db.prepare("UPDATE fib_gate SET level_idx = 0, level = 5, status = 'ramping', hold_until = NULL WHERE id = 1").run();
  console.log("8. fib gate state machine ok");
}

// ── 9. seed-test pre-send gate ─────────────────────────────────────
{
  let c = await preSendGateCheck(db, "daily_digest");
  assert.equal(c.ok, false, "blocked with no seed test");
  await recordSeedTest(db, { template: "daily_digest", inboxPct: 70, spamPct: 8 });
  c = await preSendGateCheck(db, "daily_digest");
  assert.equal(c.ok, false, "blocked on poor seed test");
  await recordSeedTest(db, { template: "daily_digest", inboxPct: 92, spamPct: 2 });
  c = await preSendGateCheck(db, "daily_digest");
  assert.equal(c.ok, true, "passes on good seed test");
  console.log("9. seed-test gate ok");
}

// ── 10. personalization ────────────────────────────────────────────
{
  const compR = await db.prepare("INSERT INTO company (name, slug, source, industry) VALUES (?, ?, 'fortune_500', 'Technology')").bind("Acme Corp", "acme-corp").run();
  const compId = compR.meta.last_row_id;
  await db.prepare(`INSERT INTO job (company_id, external_id, source_kind, url, title, location, remote_policy, employment_type, salary_min, salary_max, posted_at, description_text)
    VALUES (?, 'e1', 'html', 'https://acme.example/j1', 'Senior Backend Engineer', 'New York, NY', 'hybrid', 'full_time', 140000, 180000, '2026-09-10', 'x')`).bind(compId).run();
  await db.prepare(`INSERT INTO job (company_id, external_id, source_kind, url, title, location, remote_policy, employment_type, posted_at, description_text)
    VALUES (?, 'e2', 'html', 'https://acme.example/j2', 'Backend Engineer', 'Remote', 'remote', 'full_time', '2026-09-11', 'x')`).bind(compId).run();
  const job1 = await db.prepare("SELECT id FROM job WHERE external_id = 'e1'").first();
  const job2 = await db.prepare("SELECT id FROM job WHERE external_id = 'e2'").first();

  // user with fits + resume score
  await db.prepare("INSERT INTO app_user (email, password_hash, newsletter_opt_in) VALUES (?, 'x', 1)").bind("member@example.com").run();
  const user = await db.prepare("SELECT id FROM app_user WHERE email = ?").bind("member@example.com").first();
  await db.prepare("INSERT INTO user_job_fit (user_id, job_id, score, reasons, hard_no) VALUES (?, ?, 92, '[]', 0)").bind(user.id, job1.id).run();
  await db.prepare("INSERT INTO user_job_fit (user_id, job_id, score, reasons, hard_no) VALUES (?, ?, 81, '[]', 0)").bind(user.id, job2.id).run();
  await db.prepare("INSERT INTO user_resume (user_id, filename, text, llm_review_json, is_active) VALUES (?, 'r.pdf', 'x', ?, 1)")
    .bind(user.id, JSON.stringify({ score: 68, summary: "ok" })).run();

  const p1 = await personalizeForContact(db, { email: "member@example.com" });
  assert.equal(p1.matches.length, 2, "top fits returned");
  assert.equal(p1.matches[0].score, 92, "ordered by score desc");
  assert.equal(p1.resumeScore, 68, "resume score extracted");
  assert.equal(p1.hasResume, true);

  // legacy fallback: role + state keyword matching
  const p2 = await personalizeForContact(db, { email: "stranger@example.com", roleTitle: "Backend Engineer", state: "NY" });
  assert.ok(p2.matches.length >= 1, "legacy role/state fallback finds jobs");
  assert.equal(p2.hasResume, false);
  assert.equal(p2.resumeScore, null);

  // rendered copy: score shown when present; invite when absent; no guarantees
  const withScore = renderDigestEmail({ contact: { email: "a@x.com", firstName: "Sam" }, personalization: p1, unsubUrl: "https://u/x", appUrl: "https://jobs.mehyar.us" });
  assert.ok(withScore.html.includes("68/100"), "score rendered");
  assert.ok(!/guarantee/i.test(withScore.html + withScore.text), "no guarantee language (with score)");
  const invite = renderDigestEmail({ contact: { email: "b@x.com" }, personalization: p2, unsubUrl: "https://u/x", appUrl: "https://jobs.mehyar.us" });
  assert.ok(invite.html.includes("Free resume fit score"), "invite CTA rendered");
  assert.ok(!/guarantee/i.test(invite.html + invite.text), "no guarantee language (invite)");
  assert.ok(invite.html.includes("https://u/x"), "unsubscribe link present");
  console.log("10. personalization + copy rules ok");
}

// ── 11. queueDailySends dry-run ─────────────────────────────────────
{
  await db.prepare("DELETE FROM email_contact").run();
  await db.prepare("UPDATE fib_gate SET level_idx = 0, level = 5, status = 'ramping', hold_until = NULL WHERE id = 1").run();
  await importEmailContacts(db, [
    { email: "dry1@gmail.com", firstName: "Dry", state: "NY", roleTitle: "Backend Engineer" },
    { email: "bad-email", firstName: "Bad" },
    { email: "dry2@outlook.com", firstName: "Dry2" },
  ]);
  const res = await queueDailySends(db, env, { live: false, now: new Date(), appUrl: "https://jobs.mehyar.us" });
  assert.equal(res.ok, true);
  assert.equal(res.results.dryRun, 2, "two valid contacts dry-run queued");
  assert.equal(res.results.sent, 0, "nothing actually sent");
  assert.equal(fetchCalls.length, 0, "no ESP HTTP calls in dry-run");
  const rows = await db.prepare("SELECT status, provider_used FROM email_send").all();
  assert.ok(rows.results.every((r) => r.status === "dry_run"), "all rows dry_run");
  const marked = await db.prepare("SELECT status, sent_count FROM email_contact WHERE email = 'dry1@gmail.com'").first();
  assert.equal(marked.status, "active", "pending -> active after queue");
  assert.equal(marked.sent_count, 1);

  // live flag without EMAIL_LIVE still dry-runs (defense in depth)
  const res2 = await queueDailySends(db, env, { live: true, now: new Date(), appUrl: "https://jobs.mehyar.us" });
  assert.equal(res2.results.sent, 0, "no EMAIL_LIVE=1 -> no sends even with live:true");
  assert.equal(fetchCalls.length, 0);
  console.log("11. queueDailySends dry-run ok");
}

// ── 12. subject spintax ──────────────────────────────────────────────
{
  const base = {
    firstName: "Sam", roleTitle: "Backend Engineer",
    matches: [{ title: "Senior Backend Engineer" }, { title: "Backend Engineer" }],
    variant: "standard", dateStr: "2026-09-14",
  };
  const s1 = digestSubject({ ...base, email: "a@example.com" });
  const s1b = digestSubject({ ...base, email: "a@example.com" });
  assert.equal(s1, s1b, "subject stable per recipient per day");
  assert.ok(typeof s1 === "string" && s1.length > 0 && s1.length <= 78, "subject sane length");

  // rotation varies across recipients
  const subjects = new Set();
  for (let i = 0; i < 30; i++) subjects.add(digestSubject({ ...base, email: `user${i}@example.com` }));
  assert.ok(subjects.size >= 3, `subjects rotate across recipients (got ${subjects.size} distinct)`);

  // copy rules: no FREE, no shouty caps runs, no excessive punctuation
  for (const s of subjects) {
    assert.ok(!/\bfree\b/i.test(s), `no FREE in subject: ${s}`);
    assert.ok(!/[A-Z]{4,}/.test(s), `no shouty caps: ${s}`);
    assert.ok(!s.includes("!!") && !s.includes("??"), `no excessive punctuation: ${s}`);
  }

  // winback pool is distinct
  const w = digestSubject({ ...base, email: "w@example.com", variant: "winback", matches: [] });
  assert.ok(/hunt|saved/i.test(w), `winback subject themed: ${w}`);

  // renderDigestEmail wires dateStr through deterministically
  const rp = { matches: [], resumeScore: null, hasResume: false };
  const r1 = renderDigestEmail({ contact: { email: "a@example.com", firstName: "Sam" }, personalization: rp, unsubUrl: "https://u/x", appUrl: "https://jobs.mehyar.us", dateStr: "2026-09-14" });
  const r2 = renderDigestEmail({ contact: { email: "a@example.com", firstName: "Sam" }, personalization: rp, unsubUrl: "https://u/x", appUrl: "https://jobs.mehyar.us", dateStr: "2026-09-14" });
  assert.equal(r1.subject, r2.subject, "rendered subject deterministic");
  console.log("12. subject spintax ok");
}

console.log("\nAll email funnel tests passed.");
process.exit(0);
