// Admin: per-product email performance ("Mayor Jobs" tab Products table).
//
// GET /api/admin/email/product-stats
//   For every product in the catalog: times featured (distinct plan days
//   whose plan_json.product_slug is the slug), engagement from
//   email_event product tags (events, clicks, opens, CTR, last seen),
//   and catalog status (active/approved/category/url).
//   Read-only: never writes, never touches EMAIL_LIVE.

import { json, onRequestOptions, requireAdmin } from "../../../_shared/adminAuth.js";
import { ensureSchema } from "../../../_shared/db.js";

export { onRequestOptions as onRequest };

/**
 * Build the per-product stats. Exported for unit tests.
 * @param {object} db D1-ish handle
 * @returns {Promise<{ ok: boolean, products: object[] }>}
 */
export async function buildProductStats(db) {
  // All catalog rows (not just eligible — the table shows status too).
  const catalog = await db.prepare("SELECT * FROM product_slot ORDER BY id").all()
    .then((r) => r.results || []).catch(() => []);

  // Engagement from email_event product tags (all time; the table is small).
  const eventRows = await db.prepare(
    `SELECT json_extract(meta_json, '$.product') AS slug,
            COUNT(*) AS events,
            SUM(CASE WHEN kind = 'click' THEN 1 ELSE 0 END) AS clicks,
            SUM(CASE WHEN kind = 'open' THEN 1 ELSE 0 END) AS opens,
            MAX(date(created_at)) AS last_seen
     FROM email_event
     WHERE json_extract(meta_json, '$.product') IS NOT NULL
     GROUP BY slug`
  ).all().then((r) => r.results || []).catch(() => []);
  const bySlug = {};
  for (const r of eventRows) bySlug[r.slug] = r;

  // Times featured: distinct campaign_plan days naming this product_slug.
  // Older rows predate the plan writer; fall back to the deterministic
  // rotation? No — report only what the plan records, and say so.
  const planRows = await db.prepare("SELECT plan_date, plan_json FROM campaign_plan")
    .all().then((r) => r.results || []).catch(() => []);
  const featuredDays = {};
  for (const pr of planRows) {
    try {
      const slug = JSON.parse(pr.plan_json || "{}").product_slug;
      if (slug) {
        featuredDays[slug] = featuredDays[slug] || new Set();
        featuredDays[slug].add(pr.plan_date);
      }
    } catch { /* corrupt row: skip */ }
  }

  const products = catalog.map((p) => {
    const e = bySlug[p.slug] || { events: 0, clicks: 0, opens: 0, last_seen: null };
    const events = Number(e.events || 0);
    const clicks = Number(e.clicks || 0);
    return {
      slug: p.slug,
      name: p.name,
      category: p.category,
      url: p.url,
      active: p.active === 1,
      approved: p.approved === 1,
      cooldown_days: p.cooldown_days,
      last_featured_on: p.last_featured_on,
      times_featured: featuredDays[p.slug] ? featuredDays[p.slug].size : 0,
      events,
      clicks,
      opens: Number(e.opens || 0),
      ctr: events > 0 ? Math.round((clicks / events) * 1e6) / 1e6 : 0,
      last_seen: e.last_seen || null,
    };
  });
  return { ok: true, products };
}

export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message || "unauthorized" }, auth.status || 401, request, env);
  await ensureSchema(env).catch(() => null);
  const stats = await buildProductStats(env.JOBS_DB);
  return json(stats, 200, request, env);
}
