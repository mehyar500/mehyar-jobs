// /api/admin/jobs/backfill-salaries
//
//   POST { limit?: number, force?: boolean }
//
// Iterate all active jobs, re-extract salary from the stored
// description_text + page_content, and persist salary_min/max/currency.
//
// Useful when adding new jobs that didn't capture salary at scrape time
// (the description parser only runs on first scrape).

import { requireAdmin, json, corsHeaders, onRequestOptions } from "../../../_shared/adminAuth.js";
import { ensureSchema } from "../../../_shared/db.js";
import { extractSalary } from "../../../_shared/salary.js";

export { onRequestOptions as onRequest };

export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);

  let body = {};
  try { body = await request.json(); } catch { body = {}; }
  const limit  = Math.max(1, Math.min(5000, parseInt(body.limit || "300", 10)));
  const force  = !!body.force;

  // Fetch job ids + their description
  const where = force
    ? "WHERE j.is_active = 1 AND (j.description_text IS NOT NULL OR j.description_html IS NOT NULL)"
    : "WHERE j.is_active = 1 AND j.salary_min IS NULL AND (j.description_text IS NOT NULL OR j.description_html IS NOT NULL)";

  const rows = (await env.JOBS_DB.prepare(`
    SELECT j.id, j.title, j.description_text, j.description_html
    FROM job j
    ${where}
    ORDER BY j.first_seen_at DESC
    LIMIT ?
  `).bind(limit).all()).results || [];

  let updated = 0;
  let scanned = 0;
  const results = [];

  for (const job of rows) {
    scanned++;
    const desc = (job.description_text || "") + "\n" + (job.description_html || "");
    const s = extractSalary(desc);
    if (!s) {
      results.push({ id: job.id, ok: false, reason: "no_pattern" });
      continue;
    }
    try {
      await env.JOBS_DB.prepare(`
        UPDATE job SET salary_min = ?, salary_max = ?, salary_currency = ?
        WHERE id = ?
      `).bind(s.min, s.max, s.currency || "USD", job.id).run();
      updated++;
      results.push({ id: job.id, ok: true, min: s.min, max: s.max, currency: s.currency, raw: s.raw });
    } catch (e) {
      results.push({ id: job.id, ok: false, reason: "db_error", error: e?.message });
    }
  }

  return json({
    ok: true,
    updated,
    scanned,
    remaining_candidates: Math.max(0, limit - scanned),
    sample: results.filter((r) => r.ok).slice(0, 10),
    total_processed: results.length,
    force,
    message: `Updated ${updated}/${scanned} jobs with salary data.`,
  }, 200, request, env);
}

export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  // Quick status
  const rows = (await env.JOBS_DB.prepare(`
    SELECT
      COUNT(*) as total_active,
      SUM(CASE WHEN salary_min IS NOT NULL AND salary_min > 0 THEN 1 ELSE 0 END) as with_salary,
      SUM(CASE WHEN salary_min IS NULL OR salary_min = 0 THEN 1 ELSE 0 END) as without_salary
    FROM job WHERE is_active = 1
  `).all()).results?.[0] || {};
  return json({ ok: true, ...rows }, 200, request, env);
}
