// Admin: per-landing-page stats for the day (Worker 6).
//
// GET /api/admin/email/landing-stats?date=YYYY-MM-DD
//   date defaults to today (UTC); bad format -> 400.
//   Returns per slug/page for the day:
//     { slug, page_type: 'preference'|'gear'|'go', product_slug?, clicks, unique_clicks, created_at }
//
// Same admin auth as campaign-report.js (requireAdmin via MESC_JWT_SECRET).

import { json, onRequestOptions, requireAdmin } from "../../../_shared/adminAuth.js";
import { ensureSchema } from "../../../_shared/db.js";
import { landingStatsForDate, DATE_RE } from "../../../_shared/landing.js";

export { onRequestOptions as onRequest };

export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message || "unauthorized" }, auth.status || 401, request, env);
  await ensureSchema(env).catch(() => null);

  const url = new URL(request.url);
  let dateStr = url.searchParams.get("date");
  if (!dateStr) dateStr = new Date().toISOString().slice(0, 10);
  if (!DATE_RE.test(dateStr)) {
    return json({ ok: false, error: "bad_date: use YYYY-MM-DD" }, 400, request, env);
  }

  const stats = await landingStatsForDate(env.JOBS_DB, dateStr);
  return json({ ok: true, date: dateStr, stats }, 200, request, env);
}
