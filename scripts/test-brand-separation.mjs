// scripts/test-brand-separation.mjs
// Brand-separated subscriber tracking (D1 shim):
//   1. brand registry seeded with the 4 owned brands.
//   2. Same email can live on two brands' lists (UNIQUE(email, brand)).
//   3. importEmailContacts honors per-contact brand + ON CONFLICT(email, brand).
//   4. logEmailSend stamps brand on the send row.
//   5. recordEmailEvent attributes to the right brand (explicit or most-recent-send).
//   6. buildCampaignReport.summary.by_brand breaks down sends/events per brand.
//   7. ensureEmailContact is brand-scoped.
//   8. buildDailyList only pulls the requested brand's contacts.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureSchema } from "../functions/_shared/db.js";
import { buildCampaignReport } from "../functions/_shared/campaignReport.js";
import {
  importEmailContacts, logEmailSend, recordEmailEvent, buildDailyList,
} from "../functions/_shared/emailFunnel.js";
import { ensureEmailContact } from "../functions/_shared/landing.js";

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

// 1. brand registry
const brands = await db.prepare("SELECT slug FROM brand ORDER BY slug").all().then(r => r.results.map(x => x.slug));
assert.deepEqual(brands, ["aimech.app", "mehyar.jobs", "mehyar.us", "rizza.app"]);
console.log("ok 1 - brand registry seeded:", brands.join(","));

// 2+3. same email, two brands via import
const res = await importEmailContacts(db, [
  { email: "sam@example.com", brand: "mehyar.jobs", source: "legacy" },
  { email: "sam@example.com", brand: "aimech.app", source: "web" },
  { email: "sam@example.com", brand: "mehyar.jobs", source: "legacy" }, // dupe -> skipped
  { email: "jo@example.com", brand: "mehyar.us", source: "web" },
]);
const rows = await db.prepare("SELECT email, brand FROM email_contact ORDER BY brand").all().then(r => r.results);
assert.equal(rows.length, 3); // dupe did not create a 4th row
assert.deepEqual(rows.map(r => r.brand), ["aimech.app", "mehyar.jobs", "mehyar.us"]);
console.log("ok 2 - UNIQUE(email, brand): same email on 2 brands, dupe skipped");

// 7. ensureEmailContact is brand-scoped
const cA = await ensureEmailContact(db, "sam@example.com", "aimech.app");
const cJ = await ensureEmailContact(db, "sam@example.com", "mehyar.jobs");
assert.notEqual(cA.id, cJ.id);
assert.equal(cA.brand, "aimech.app");
assert.equal(cJ.brand, "mehyar.jobs");
console.log("ok 3 - ensureEmailContact brand-scoped");

// 4. sends stamped per brand
await logEmailSend(db, { contactId: cJ.id, brand: "mehyar.jobs", kind: "warmup", template: "daily_digest", variant: "standard", subject: "Jobs", providerUsed: "smtp2go", status: "sent" });
await logEmailSend(db, { contactId: cA.id, brand: "aimech.app", kind: "warmup", template: "daily_digest", variant: "standard", subject: "Car tips", providerUsed: "smtp2go", status: "sent" });
// backdate to DAY so the report counts them
await db.prepare("UPDATE email_send SET sent_at = ?, created_at = ?").bind(`${DAY}T09:00:00Z`, `${DAY} 09:00:00`).run();
const sendBrands = await db.prepare("SELECT brand, COUNT(*) AS n FROM email_send GROUP BY brand ORDER BY brand").all().then(r => r.results);
assert.deepEqual(sendBrands.map(r => `${r.brand}:${r.n}`), ["aimech.app:1", "mehyar.jobs:1"]);
console.log("ok 4 - logEmailSend stamps brand");

// 5. events attribute per brand
await recordEmailEvent(db, "sam@example.com", "open", { brand: "aimech.app" });
await recordEmailEvent(db, "sam@example.com", "click"); // no brand -> most recent send (tie -> either is fine, must be one of them)
await db.prepare("UPDATE email_event SET created_at = ?").bind(`${DAY}T10:00:00Z`).run();
const evBrands = await db.prepare("SELECT brand, kind FROM email_event ORDER BY id").all().then(r => r.results);
assert.equal(evBrands[0].brand, "aimech.app");
assert.ok(["aimech.app", "mehyar.jobs"].includes(evBrands[1].brand));
console.log("ok 5 - recordEmailEvent brand attribution:", evBrands.map(e => `${e.brand}/${e.kind}`).join(", "));

// 6. report by_brand breakdown
const report = await buildCampaignReport(db, DAY, {});
const bb = report.summary.by_brand;
assert.equal(bb["mehyar.jobs"].sends, 1);
assert.equal(bb["aimech.app"].sends, 1);
assert.equal(bb["aimech.app"].opens, 1);
assert.equal(report.summary.sends, 2);
console.log("ok 6 - campaign report by_brand:", JSON.stringify(bb));

// 8. buildDailyList brand filter (needs gate + engagement rows)
await db.prepare("INSERT OR IGNORE INTO fib_gate (id, level, status) VALUES (1, 5, 'ramping')").run().catch(() => {});
await db.prepare("INSERT INTO contact_engagement (contact_id) VALUES (?), (?), (?)").bind(cJ.id, cA.id, rows[2] && 0).run().catch(() => {});
const listJ = await buildDailyList(db, { brand: "mehyar.jobs" });
const listA = await buildDailyList(db, { brand: "aimech.app" });
assert.ok(listJ.list.every(c => c.brand === "mehyar.jobs"), "jobs list only jobs brand");
assert.ok(listA.list.every(c => c.brand === "aimech.app"), "aimech list only aimech brand");
console.log("ok 7 - buildDailyList brand filter: jobs=" + listJ.list.length + " aimech=" + listA.list.length);

console.log("\nAll brand separation tests passed.");
process.exit(0);
