// GET /api/jobs — public job browser. No auth.
//
// Query params: q, industry, location, remote (remote|hybrid|onsite),
// employment_type, page (1-based), per_page (max 50).

import { ensureSchema } from "../_shared/db.js";
import { json, corsHeaders, onRequestOptions } from "../_shared/adminAuth.js";

export { onRequestOptions as onRequest };

export async function onRequestGet({ request, env }) {
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);
  const db = env.JOBS_DB;
  const url = new URL(request.url);

  const q = (url.searchParams.get("q") || "").trim().slice(0, 120);
  const industry = (url.searchParams.get("industry") || "").trim().slice(0, 80);
  const location = (url.searchParams.get("location") || "").trim().slice(0, 80);
  const remote = (url.searchParams.get("remote") || "").trim().toLowerCase();
  const employment_type = (url.searchParams.get("employment_type") || "").trim().toLowerCase();
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const per_page = Math.min(50, Math.max(1, parseInt(url.searchParams.get("per_page") || "20", 10) || 20));

  const where = ["j.is_active = 1"];
  const binds = [];
  if (q) { where.push("(j.title LIKE ? OR j.description_text LIKE ? OR c.name LIKE ?)"); binds.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (industry) { where.push("c.industry = ?"); binds.push(industry); }
  if (location) { where.push("j.location LIKE ?"); binds.push(`%${location}%`); }
  if (["remote", "hybrid", "onsite"].includes(remote)) { where.push("j.remote_policy = ?"); binds.push(remote); }
  if (employment_type) { where.push("j.employment_type = ?"); binds.push(employment_type); }

  const whereSql = where.join(" AND ");
  const total = await db.prepare(
    `SELECT COUNT(*) AS n FROM job j JOIN company c ON c.id = j.company_id WHERE ${whereSql}`
  ).bind(...binds).first().catch(() => ({ n: 0 }));

  const jobs = await db.prepare(`
    SELECT j.id, j.title, j.url, j.location, j.remote_policy, j.employment_type,
           j.salary_min, j.salary_max, j.salary_currency, j.posted_at, j.first_seen_at,
           c.name AS company_name, c.industry AS company_industry
    FROM job j JOIN company c ON c.id = j.company_id
    WHERE ${whereSql}
    ORDER BY j.first_seen_at DESC
    LIMIT ? OFFSET ?
  `).bind(...binds, per_page, (page - 1) * per_page).all().catch(() => ({ results: [] }));

  const industries = await db.prepare(`
    SELECT c.industry AS industry, COUNT(*) AS n
    FROM job j JOIN company c ON c.id = j.company_id
    WHERE j.is_active = 1 AND c.industry IS NOT NULL AND c.industry != ''
    GROUP BY c.industry ORDER BY n DESC LIMIT 40
  `).all().catch(() => ({ results: [] }));

  return json({
    ok: true,
    jobs: jobs.results || [],
    total: total?.n || 0,
    page, per_page,
    industries: (industries.results || []).map((r) => ({ industry: r.industry, count: r.n })),
  }, 200, request, env);
}
