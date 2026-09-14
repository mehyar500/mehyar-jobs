// scripts/test-product-details.mjs
// Worker 1 (product enrichment) — migration 0019 guarantees (D1 shim):
//   1. Migration 0019 applies cleanly on a fresh DB (incl. re-run via
//      ensureSchema idempotency); description column exists.
//   2. Descriptions present (non-empty) for all 9 products.
//   3. Verified ASINs (ring-light B0FLJV1BVB, parachute-book 1984861204)
//      are active+approved with exact affiliate links.
//   4. Only active+approved products have non-NULL Amazon urls; no ASIN
//      outside the verified allowlist; UNAPPROVED yotru/jobtestprep stay
//      approved=0 AND active=0 (their program-page urls are the only
//      documented non-Amazon exception).
//   5. image_url is NULL for all 9 (nothing invented).
//   6. Rotation never features yotru/jobtestprep (60-day sweep).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { ensureSchema } from "../functions/_shared/db.js";
import { MIGRATION_0019 } from "../functions/_shared/migrations.js";
import { getProductOfDay } from "../functions/_shared/productCatalog.js";

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

// ASINs verified against live Amazon dp pages on 2026-09-13. Anything
// else in an amazon.com/dp/ URL is an invented ASIN — fail the test.
const VERIFIED_ASINS = new Set([
  "B07K986YLL", // logitech-c920s (affiliate content, pre-existing)
  "B01MXL3EOU", // fifine-k669 (affiliate content, pre-existing)
  "B076VNFZJG", // screenbar (affiliate content, pre-existing)
  "B0B11LJ69K", // mx-master (web-verified 2026-09-13, pre-existing)
  "B0H2BHDDSV", // ember-mug (web-verified 2026-09-13, pre-existing)
  "B0FLJV1BVB", // ring-light (worker 1, 2026-09-13)
  "1984861204", // parachute-book (worker 1, 2026-09-13; ISBN-10 of 978-1984861207)
]);

const env = { JOBS_DB: new D1Shim() };

// ── 1. migration 0019 applies cleanly on a fresh DB ─────────────────
{
  // The embedded export must match the source file (minus the backtick
  // normalization done at registration time).
  const file = readFileSync(new URL("../migrations/0019_product_details.sql", import.meta.url), "utf8");
  assert.equal(MIGRATION_0019, file.replaceAll("`description`", "'description'"),
    "migrations.js export in sync with migrations/0019_product_details.sql");

  await ensureSchema(env);
  const db = env.JOBS_DB;
  const cols = (await db.prepare("PRAGMA table_info(product_slot)").all()).results.map((c) => c.name);
  assert.ok(cols.includes("description"), "description column added");

  // Re-running the whole schema is idempotent (runner skips applied migrations).
  await ensureSchema(env);
  const n = await db.prepare("SELECT COUNT(*) AS n FROM product_slot").first();
  assert.equal(n.n, 9, "still 9 products after re-run");
  console.log("1. migration 0019 applies cleanly (fresh + re-run)");
}

const db = env.JOBS_DB;

// ── 2. descriptions present for all 9 ──────────────────────────────
{
  const rows = (await db.prepare("SELECT slug, description FROM product_slot").all()).results;
  assert.equal(rows.length, 9, "9 products");
  for (const r of rows) {
    assert.ok(r.description && r.description.trim().length > 0, `${r.slug}: description present`);
    assert.ok(r.description.split(/\s+/).length >= 8, `${r.slug}: description is 1-2 sentences, not a stub`);
  }
  console.log("2. descriptions present for all 9");
}

// ── 3. verified ASINs activated with exact affiliate links ─────────
{
  const rl = await db.prepare("SELECT slug, url, active, approved FROM product_slot WHERE slug='ring-light'").first();
  assert.equal(rl.url, "https://www.amazon.com/dp/B0FLJV1BVB?tag=mehyarus-20");
  assert.equal(rl.active, 1, "ring-light active");
  assert.equal(rl.approved, 1, "ring-light approved");

  const pb = await db.prepare("SELECT slug, url, active, approved FROM product_slot WHERE slug='parachute-book'").first();
  assert.equal(pb.url, "https://www.amazon.com/dp/1984861204?tag=mehyarus-20");
  assert.equal(pb.active, 1, "parachute-book active");
  assert.equal(pb.approved, 1, "parachute-book approved");
  console.log("3. verified ASINs activated with exact affiliate links");
}

// ── 4. url/active/approved integrity + no invented ASINs ───────────
{
  const rows = (await db.prepare("SELECT slug, url, active, approved FROM product_slot").all()).results;
  for (const p of rows) {
    if (p.url === null) {
      assert.equal(p.active, 0, `${p.slug}: NULL url must be inactive`);
      continue;
    }
    if (p.url.includes("amazon.com/dp/")) {
      const asin = p.url.match(/amazon\.com\/dp\/([A-Z0-9]+)/)[1];
      assert.ok(VERIFIED_ASINS.has(asin), `${p.slug}: ASIN ${asin} not in verified allowlist`);
      assert.equal(p.active, 1, `${p.slug}: Amazon-linked product must be active`);
      assert.equal(p.approved, 1, `${p.slug}: Amazon-linked product must be approved`);
      assert.ok(p.url.endsWith("?tag=mehyarus-20"), `${p.slug}: affiliate tag present`);
    } else {
      // The only documented non-Amazon urls are the UNAPPROVED program
      // homepages (never featured, never linked in emails until approved).
      assert.ok(["yotru", "jobtestprep"].includes(p.slug), `${p.slug}: unexpected non-Amazon url`);
      assert.equal(p.active, 0, `${p.slug}: unapproved program must stay inactive`);
      assert.equal(p.approved, 0, `${p.slug}: unapproved program must stay unapproved`);
    }
  }
  const actives = (await db.prepare(
    "SELECT COUNT(*) AS n FROM product_slot WHERE active=1 AND approved=1 AND url IS NOT NULL"
  ).first());
  assert.equal(actives.n, 7, "all 7 active+approved products have urls");
  console.log("4. url/active/approved integrity ok (no invented ASINs)");
}

// ── 5. image_url NULL for all 9 (nothing invented) ─────────────────
{
  const rows = (await db.prepare("SELECT slug, image_url FROM product_slot").all()).results;
  for (const p of rows) {
    assert.equal(p.image_url, null, `${p.slug}: image_url must be NULL until a verified source exists`);
  }
  console.log("5. image_url NULL for all 9 (no invented images)");
}

// ── 6. unapproved products never featured (60-day sweep) ──────────
{
  const d = new Date("2026-09-14T00:00:00Z");
  for (let i = 0; i < 60; i++) {
    const ds = d.toISOString().slice(0, 10);
    const p = await getProductOfDay(db, ds);
    assert.ok(p, `${ds} picks a product`);
    assert.ok(p.approved === 1 && p.active === 1, `${ds}: picked product is eligible`);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  console.log("6. rotation eligibility sweep ok (60 days)");
}

console.log("ALL PRODUCT DETAILS TESTS PASSED");
process.exit(0);
