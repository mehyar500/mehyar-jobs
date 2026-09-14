// scripts/test-product-catalog.mjs
// Product catalog tests (D1 shim) — updated for migration 0019
// (ring-light + parachute-book verified and activated; `description`
// column added; 7 active+approved products, 3 eligible categories).
//   1. Migrations 0018+0019 apply; product_slot + system_flag exist;
//      9 products seeded; description column present.
//   2. getProductOfDay is deterministic (same date -> same product).
//   3. Mon-Fri category rotation: day's category = categories[weekdayIdx % n].
//   4. 30-day cooldown respected (featured product not re-picked within window).
//   5. Unapproved/inactive products are NEVER selected (60-day sweep).
//   6. No invented ASINs: every non-null url matches the allowed pattern;
//      only yotru/jobtestprep (UNAPPROVED, inactive) keep non-Amazon links.
//   7. markFeatured stamps last_featured_on; getActiveProducts/getProductBySlug work.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureSchema } from "../functions/_shared/db.js";
import {
  activeCategories, getActiveProducts, getProductBySlug,
  getProductOfDay, productAngles, getSystemFlag, setSystemFlag,
} from "../functions/_shared/productCatalog.js";

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

// Only the two UNAPPROVED-program products are ineligible now.
const INELIGIBLE = new Set(["yotru", "jobtestprep"]);
const URL_RE = /^https:\/\/(www\.amazon\.com\/dp\/[A-Z0-9]+\?tag=mehyarus-20|(www\.)?yotru\.com|(www\.)?jobtestprep\.com)/;

// ── 1. migrations 0018+0019 ────────────────────────────────────────
{
  for (const t of ["product_slot", "system_flag"]) {
    const r = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(t).first();
    assert.ok(r, `table ${t} exists`);
  }
  const cols = (await db.prepare("PRAGMA table_info(product_slot)").all()).results.map((c) => c.name);
  assert.ok(cols.includes("description"), "description column added by migration 0019");
  const r = await db.prepare("SELECT COUNT(*) AS n FROM product_slot").first();
  assert.equal(r.n, 9, "9 products seeded");
  const cats = await activeCategories(db);
  assert.deepEqual(cats, ["books", "desk_setup", "interview_gear"], "eligible categories listed A-Z");
  console.log("1. migrations 0018+0019 + seeding ok");
}

// ── 2. determinism ─────────────────────────────────────────────────
{
  const a = await getProductOfDay(db, "2026-09-14");
  const b = await getProductOfDay(db, "2026-09-14");
  assert.ok(a && b);
  assert.equal(a.slug, b.slug, "same date -> same product");
  console.log(`2. determinism ok (2026-09-14 -> ${a.slug})`);
}

// ── 3. Mon-Fri category rotation ───────────────────────────────────
// 2026-09-14 is a Monday. Categories A-Z: books(0), desk_setup(1), interview_gear(2).
// Mon: books, Tue: desk_setup, Wed: interview_gear, Thu: books, Fri: desk_setup.
{
  const expected = {
    "2026-09-14": "books",
    "2026-09-15": "desk_setup",
    "2026-09-16": "interview_gear",
    "2026-09-17": "books",
    "2026-09-18": "desk_setup",
  };
  for (const [date, cat] of Object.entries(expected)) {
    const p = await getProductOfDay(db, date);
    assert.ok(p, `${date} picks a product`);
    assert.equal(p.category, cat, `${date} rotates to ${cat}`);
  }
  console.log("3. Mon-Fri category rotation ok");
}

// ── 4. 30-day cooldown ─────────────────────────────────────────────
{
  // Feature the product picked for Tuesday 2026-09-15 (desk_setup).
  const first = await getProductOfDay(db, "2026-09-15", { markFeatured: true });
  const row = await db.prepare("SELECT last_featured_on FROM product_slot WHERE id = ?").bind(first.id).first();
  assert.equal(row.last_featured_on, "2026-09-15", "markFeatured stamps the date");

  // Thursday 2026-09-17 is also desk_setup; the featured product must not repeat.
  const thu = await getProductOfDay(db, "2026-09-17");
  assert.notEqual(thu.slug, first.slug, "cooldown keeps featured product out of rotation");

  // Same date (day 0) is within cooldown too.
  const same = await getProductOfDay(db, "2026-09-15");
  assert.notEqual(same.slug, first.slug, "same-day re-pick respects cooldown");

  // 31 days later the product is eligible again (may or may not be picked
  // by hash — just assert eligibility).
  const elig = await db.prepare(
    `SELECT slug FROM product_slot WHERE active = 1 AND approved = 1 AND category = 'desk_setup'
     AND (last_featured_on IS NULL OR last_featured_on <= date('2026-10-16', '-' || cooldown_days || ' days'))`
  ).all();
  assert.ok(elig.results.some((x) => x.slug === first.slug), "eligible again after 31 days");
  console.log(`4. cooldown ok (featured ${first.slug}, next desk_setup day -> ${thu.slug})`);
}

// ── 5. unapproved/inactive never selected (60-day sweep) ───────────
{
  const d = new Date("2026-09-14T00:00:00Z");
  for (let i = 0; i < 60; i++) {
    const ds = d.toISOString().slice(0, 10);
    const p = await getProductOfDay(db, ds);
    assert.ok(p, `${ds} picks a product`);
    assert.ok(!INELIGIBLE.has(p.slug), `${ds}: ineligible ${p.slug} must never be picked`);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  // Weekend days still return a product.
  const sat = await getProductOfDay(db, "2026-09-19"); // Saturday
  const sun = await getProductOfDay(db, "2026-09-20"); // Sunday
  assert.ok(sat && sun, "weekend days return a product");
  console.log("5. eligibility sweep ok (60 days, weekend covered)");
}

// ── 6. no invented ASINs ───────────────────────────────────────────
{
  const all = (await db.prepare("SELECT slug, url, active, approved FROM product_slot").all()).results;
  for (const p of all) {
    if (p.url === null) {
      assert.equal(p.active, 0, `${p.slug}: NULL url must be inactive (ASIN pending)`);
    } else {
      assert.match(p.url, URL_RE, `${p.slug}: url must be a verified link`);
    }
  }
  // The two newly verified ASINs have their exact affiliate links.
  const rl = await getProductBySlug(db, "ring-light");
  assert.equal(rl.url, "https://www.amazon.com/dp/B0FLJV1BVB?tag=mehyarus-20");
  assert.equal(rl.active, 1, "ring-light active after verification");
  const pb = await getProductBySlug(db, "parachute-book");
  assert.equal(pb.url, "https://www.amazon.com/dp/1984861204?tag=mehyarus-20");
  assert.equal(pb.active, 1, "parachute-book active after verification");
  // UNAPPROVED programs stay dark.
  for (const slug of ["yotru", "jobtestprep"]) {
    const p = await getProductBySlug(db, slug);
    assert.equal(p.approved, 0, `${slug}: approved stays 0`);
    assert.equal(p.active, 0, `${slug}: active stays 0`);
  }
  console.log("6. ASIN integrity ok (verified links only; unapproved stay dark)");
}

// ── 7. helpers ─────────────────────────────────────────────────────
{
  const actives = await getActiveProducts(db);
  assert.equal(actives.length, 7, "7 active+approved products");
  assert.ok(actives.every((p) => p.active === 1 && p.approved === 1));
  const p = await getProductBySlug(db, "logitech-c920s");
  assert.equal(p.name, "Logitech C920s Webcam");
  assert.equal(productAngles(p).length, 3, "3 copy angles");
  const missing = await getProductBySlug(db, "nope");
  assert.equal(missing, null);
  await setSystemFlag(db, "sender_armed", "2026-09-13T21:00:00Z");
  assert.equal(await getSystemFlag(db, "sender_armed"), "2026-09-13T21:00:00Z");
  assert.equal(await getSystemFlag(db, "missing_flag"), null);
  console.log("7. helpers ok");
}

console.log("ALL PRODUCT CATALOG TESTS PASSED");
process.exit(0);
