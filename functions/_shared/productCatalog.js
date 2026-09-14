// _shared/productCatalog.js
//
// Product catalog for the email growth engine ("Mayor Jobs" Genius Flow).
//
// One product is "featured" per day in the daily email. Products rotate
// across categories by weekday (Mon..Fri) so each day hits a different
// angle of the job hunt, and each product has a per-product cooldown
// (default 30 days) before it may be featured again.
//
// Selection is deterministic: hash(dateStr + category) picks among
// cooldown-eligible candidates, so reports and previews agree. The only
// side effect is markFeatured=true, which stamps last_featured_on.
//
// Selection gate: only rows with active=1 AND approved=1 are eligible.
// Products with approved=0 have UNAPPROVED affiliate programs and must
// never be featured or linked until acceptance.

import { hashStr } from "./emailFunnel.js";

/**
 * @typedef {object} ProductRow
 * @property {number} id
 * @property {string} slug
 * @property {string} name
 * @property {string} category
 * @property {string|null} url
 * @property {string|null} image_url
 * @property {string|null} description   -- factual 1-2 sentence product summary (migration 0019)
 * @property {string} angles_json
 * @property {number} cooldown_days
 * @property {number} active
 * @property {number} approved
 * @property {string|null} last_featured_on
 * @property {string|null} notes
 * @property {string} created_at
 */

/** Minimal D1-ish db interface used here. @typedef {object} DbLike */

/**
 * Parse the copy angles for a product row.
 * @param {ProductRow} product
 * @returns {string[]}
 */
export function productAngles(product) {
  try {
    const a = JSON.parse(product.angles_json || "[]");
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Distinct categories of eligible (active + approved) products, A-Z.
 * @param {DbLike} db
 * @returns {Promise<string[]>}
 */
export async function activeCategories(db) {
  const r = await db.prepare(
    "SELECT DISTINCT category FROM product_slot WHERE active = 1 AND approved = 1 ORDER BY category"
  ).all();
  return (r.results || []).map((x) => x.category);
}

/**
 * All eligible (active + approved) products, ordered by id.
 * @param {DbLike} db
 * @returns {Promise<ProductRow[]>}
 */
export async function getActiveProducts(db) {
  const r = await db.prepare(
    "SELECT * FROM product_slot WHERE active = 1 AND approved = 1 ORDER BY id"
  ).all();
  return r.results || [];
}

/**
 * One product by slug, regardless of active/approved state.
 * @param {DbLike} db
 * @param {string} slug
 * @returns {Promise<ProductRow|null>}
 */
export async function getProductBySlug(db, slug) {
  const r = await db.prepare("SELECT * FROM product_slot WHERE slug = ?").bind(slug).first();
  return r || null;
}

/**
 * Eligible candidates in a category: active + approved and either never
 * featured or featured on/before (dateStr - cooldown_days).
 * @param {DbLike} db
 * @param {string} category
 * @param {string} dateStr YYYY-MM-DD
 * @returns {Promise<ProductRow[]>}
 */
async function cooldownEligible(db, category, dateStr) {
  const r = await db.prepare(
    `SELECT * FROM product_slot
     WHERE active = 1 AND approved = 1 AND category = ?
       AND (last_featured_on IS NULL OR last_featured_on <= date(?, '-' || cooldown_days || ' days'))
     ORDER BY id`
  ).bind(category, dateStr).all();
  return r.results || [];
}

/**
 * Deterministic product-of-the-day.
 *
 * Weekday (Mon=1..Fri=5, weekend maps to 1..2 via modulo over categories):
 * the day's category is categories[weekdayIdx % categories.length], where
 * weekdayIdx = getUTCDay - 1 mapped so Monday=0 .. Friday=4. The pick is
 * candidates[hash(dateStr + category) % candidates.length].
 *
 * Fallbacks: any cooldown-eligible product outside the day's category,
 * then any eligible product at all (cooldown ignored — a product today
 * beats a broken digest).
 *
 * @param {DbLike} db
 * @param {string} dateStr YYYY-MM-DD
 * @param {{ markFeatured?: boolean }} [opts]
 * @returns {Promise<ProductRow|null>}
 */
export async function getProductOfDay(db, dateStr, { markFeatured = false } = {}) {
  const categories = await activeCategories(db);
  if (!categories.length) return null;

  const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
  const weekdayIdx = (dow + 6) % 7; // Monday=0 .. Sunday=6
  const category = categories[weekdayIdx % categories.length];

  let candidates = await cooldownEligible(db, category, dateStr);
  let picked = candidates.length
    ? candidates[hashStr(`${dateStr}|${category}`) % candidates.length]
    : null;

  if (!picked) {
    // Fallback 1: any cooldown-eligible product in another category.
    const other = await db.prepare(
      `SELECT * FROM product_slot
       WHERE active = 1 AND approved = 1 AND category != ?
         AND (last_featured_on IS NULL OR last_featured_on <= date(?, '-' || cooldown_days || ' days'))
       ORDER BY id`
    ).bind(category, dateStr).all();
    const others = other.results || [];
    picked = others.length ? others[hashStr(`${dateStr}|any`) % others.length] : null;
  }
  if (!picked) {
    // Fallback 2: any eligible product, cooldown ignored.
    const all = await getActiveProducts(db);
    picked = all.length ? all[hashStr(`${dateStr}|last`) % all.length] : null;
  }
  if (!picked) return null;

  if (markFeatured) {
    await db.prepare("UPDATE product_slot SET last_featured_on = ? WHERE id = ?")
      .bind(dateStr, picked.id).run();
    picked = { ...picked, last_featured_on: dateStr };
  }
  return picked;
}

/**
 * System flag get/set.
 * @param {DbLike} db
 * @param {string} key
 * @returns {Promise<string|null>}
 */
export async function getSystemFlag(db, key) {
  const r = await db.prepare("SELECT value FROM system_flag WHERE key = ?").bind(key).first();
  return r ? r.value : null;
}

/**
 * @param {DbLike} db
 * @param {string} key
 * @param {string|null} value
 */
export async function setSystemFlag(db, key, value) {
  await db.prepare(
    "INSERT INTO system_flag (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
  ).bind(key, value).run();
}
