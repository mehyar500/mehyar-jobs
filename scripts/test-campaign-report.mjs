// scripts/test-campaign-report.mjs
// Campaign report tests (D1 shim):
//   1. buildCampaignReport aggregates sends by status for the day.
//   2. Events by kind: opens, clicks, bounces, complaints, unsubscribes;
//      CTR = clicks/sends; open rate vs delivered.
//   3. emails: per template x variant x subject counts.
//   4. offers: meta_json.offer aggregation with clicks/opens.
//   5. products: product of the day + meta_json.product events.
//   6. landing_pages: active go slugs; gate row; sender_armed_at from system_flag.
//   7. smtp2goStats pass-through.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureSchema } from "../functions/_shared/db.js";
import { buildCampaignReport } from "../functions/_shared/campaignReport.js";
import { setSystemFlag } from "../functions/_shared/productCatalog.js";

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

const DAY = "2026-09-10";

async function addContact(email) {
  const r = await db.prepare(
    "INSERT INTO email_contact (email, status, source) VALUES (?, 'active', 'legacy')"
  ).bind(email).run();
  return r.meta.last_row_id;
}
async function addSend(contactId, { status = "sent", template = "daily_digest", variant = "standard", subject = "Your top matches" } = {}) {
  await db.prepare(
    `INSERT INTO email_send (contact_id, kind, template, variant, subject, provider_used, status, sent_at, created_at)
     VALUES (?, 'warmup', ?, ?, ?, 'smtp2go', ?, ?, ?)`
  ).bind(contactId, template, variant, subject, status, `${DAY}T09:00:00Z`, `${DAY}T09:00:05Z`).run();
}
async function addEvent(contactId, kind, meta = {}) {
  await db.prepare(
    "INSERT INTO email_event (contact_id, kind, mpp_suspect, meta_json, created_at) VALUES (?, ?, 0, ?, ?)"
  ).bind(contactId, kind, JSON.stringify(meta), `${DAY}T10:00:00Z`).run();
}

// Seed: 4 sends on DAY (3 sent, 1 failed), 1 send on another day (must not count).
const c1 = await addContact("a@example.com");
const c2 = await addContact("b@example.com");
const c3 = await addContact("c@example.com");
const c4 = await addContact("d@example.com");
const c5 = await addContact("e@example.com");
await addSend(c1);
await addSend(c2, { variant: "winback", subject: "Still on the hunt?" });
await addSend(c3);
await addSend(c4, { status: "failed", subject: "Your top matches" });
await db.prepare(
  `INSERT INTO email_send (contact_id, kind, template, variant, subject, provider_used, status, sent_at, created_at)
   VALUES (?, 'warmup', 'daily_digest', 'standard', 'Other day', 'smtp2go', 'sent', '2026-09-09T09:00:00Z', '2026-09-09T09:00:05Z')`
).bind(c5).run();

// Events on DAY: 2 opens, 1 click, 1 hard_bounce, 1 soft_bounce, 1 complaint, 1 unsubscribe.
await addEvent(c1, "open");
await addEvent(c2, "open");
await addEvent(c1, "click", { offer: "coursera" });
await addEvent(c3, "hard_bounce");
await addEvent(c4, "soft_bounce");
await addEvent(c2, "complaint", { offer: "coursera" });
await addEvent(c3, "unsubscribe");
await addEvent(c1, "click", { product: "logitech-c920s" });
await addEvent(c2, "open", { product: "logitech-c920s" });
// Event on another day (must not count).
await db.prepare(
  "INSERT INTO email_event (contact_id, kind, meta_json, created_at) VALUES (?, 'open', '{}', '2026-09-09T10:00:00Z')"
).bind(c5).run();

// ── 1-6. full report ───────────────────────────────────────────────
{
  const r = await buildCampaignReport(db, DAY);
  assert.equal(r.date, DAY);

  // 1. sends by status
  assert.equal(r.summary.sends, 4, "4 sends on the day");
  assert.deepEqual(r.summary.sends_by_status, { sent: 3, failed: 1 });

  // 2. events
  assert.equal(r.summary.opens, 3, "3 opens (2 plain + 1 product-tagged)");
  assert.equal(r.summary.clicks, 2, "2 clicks");
  assert.equal(r.summary.hard_bounces, 1);
  assert.equal(r.summary.soft_bounces, 1);
  assert.equal(r.summary.complaints, 1);
  assert.equal(r.summary.unsubscribes, 1);
  assert.equal(r.summary.ctr, 0.5, "ctr = clicks/sends = 2/4");
  assert.equal(r.summary.open_rate, 1, "open_rate = opens/delivered = 3/3");

  // 3. emails: template x variant x subject
  const std = r.emails.find((e) => e.variant === "standard" && e.subject === "Your top matches");
  assert.ok(std, "standard row present");
  assert.equal(std.sends, 3, "3 standard sends");
  assert.equal(std.recipients, 3);
  const wb = r.emails.find((e) => e.variant === "winback");
  assert.equal(wb.sends, 1);

  // 4. offers
  const coursera = r.offers.find((o) => o.offer === "coursera");
  assert.ok(coursera, "coursera offer aggregated");
  assert.equal(coursera.n, 2);
  assert.equal(coursera.clicks, 1);
  assert.equal(coursera.opens, 0);

  // 5. products
  assert.ok(r.products.product_of_day, "product of day present");
  assert.ok(r.products.product_of_day.slug, "product of day has slug");
  assert.equal(r.products.product_of_day.angles.length, 3);
  const pv = r.products.events.find((e) => e.product === "logitech-c920s");
  assert.ok(pv, "product-tagged events aggregated");
  assert.equal(pv.n, 2);
  assert.equal(pv.clicks, 1);
  assert.equal(pv.opens, 1);

  // 6. landing pages + gate + armed flag
  assert.ok(Array.isArray(r.landing_pages.active_go_slugs), "active go slugs listed");
  assert.ok(r.landing_pages.active_go_slugs.includes("coursera"), "offer_slot slugs present");
  assert.ok(r.landing_pages.note.includes("not yet built"));
  assert.equal(r.gate.level, 5, "fib gate row present");
  assert.equal(r.sender_armed_at, null, "not armed yet");

  console.log("1-6. report aggregation ok");
}

// ── armed flag round-trip ──────────────────────────────────────────
{
  await setSystemFlag(db, "sender_armed", "2026-09-10T12:00:00Z");
  const r = await buildCampaignReport(db, DAY);
  assert.equal(r.sender_armed_at, "2026-09-10T12:00:00Z");
  console.log("armed flag ok");
}

// ── 7. provider stats pass-through ─────────────────────────────────
{
  const stats = { source: "smtp2go", data: { sent: 3 } };
  const r = await buildCampaignReport(db, DAY, { smtp2goStats: stats });
  assert.deepEqual(r.provider, stats, "provider stats passed through verbatim");
  const r2 = await buildCampaignReport(db, DAY);
  assert.equal(r2.provider, null, "no stats -> null");
  console.log("7. provider stats ok");
}

// ── empty day ──────────────────────────────────────────────────────
{
  const r = await buildCampaignReport(db, "2026-01-01");
  assert.equal(r.summary.sends, 0);
  assert.equal(r.summary.ctr, 0, "ctr=0 on empty day (no NaN)");
  assert.ok(r.products.product_of_day, "product of day works for any date");
  console.log("empty day ok");
}

console.log("ALL CAMPAIGN REPORT TESTS PASSED");
process.exit(0);
