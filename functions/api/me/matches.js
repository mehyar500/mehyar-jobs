// GET /api/me/matches — the user's ranked matches, paginated.
// Query: page, per_page (max 50), min_score (default 0).

import { ensureSchema } from "../../_shared/db.js";
import { json, onRequestOptions, requireUser } from "../../_shared/userAuth.js";

export { onRequestOptions as onRequest };

export async function onRequestGet({ request, env }) {
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);
  const auth = await requireUser(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const per_page = Math.min(50, Math.max(1, parseInt(url.searchParams.get("per_page") || "20", 10) || 20));
  const min_score = Math.max(0, parseInt(url.searchParams.get("min_score") || "0", 10) || 0);

  const db = env.JOBS_DB;
  const total = await db.prepare(
    "SELECT COUNT(*) AS n FROM user_job_fit WHERE user_id = ? AND score >= ?"
  ).bind(auth.user.id, min_score).first().catch(() => ({ n: 0 }));

  const rows = await db.prepare(`
    SELECT j.id, j.title, j.url, j.location, j.remote_policy, j.employment_type,
           j.salary_min, j.salary_max, j.salary_currency, j.posted_at, j.first_seen_at,
           j.featured,
           c.name AS company_name, c.industry AS company_industry,
           f.score, f.reasons, f.hard_no, f.hard_no_reason, f.scored_at
    FROM user_job_fit f
    JOIN job j ON j.id = f.job_id
    JOIN company c ON c.id = j.company_id
    WHERE f.user_id = ? AND f.score >= ? AND j.is_active = 1
    ORDER BY f.score DESC
    LIMIT ? OFFSET ?
  `).bind(auth.user.id, min_score, per_page, (page - 1) * per_page).all().catch(() => ({ results: [] }));

  return json({
    ok: true,
    matches: (rows.results || []).map((r) => ({ ...r, reasons: JSON.parse(r.reasons || "[]") })),
    total: total?.n || 0,
    page, per_page,
  }, 200, request, env);
}
