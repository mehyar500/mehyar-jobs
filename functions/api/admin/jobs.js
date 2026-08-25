// GET /api/admin/jobs?fit_min=&q=&industry=&remote=&engagement=&company_id=&posted_within=&salary_min=&limit=&offset=
//
// Returns the full job table joined with company + fit-score, sorted by
// fit_score DESC. Auth: admin (cross-app via shared JWT).

import { requireAdmin, json, corsHeaders, onRequestOptions } from "../../_shared/adminAuth.js";
import { ensureSchema } from "../../_shared/db.js";
import { loadProfile } from "../../_shared/fit.js";

export { onRequestOptions as onRequest };

export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);

  await ensureSchema(env);
  const db = env.JOBS_DB;

  const url = new URL(request.url);
  const filters = readJobFilters(url);
  const { q, industry, remote, engagement, fitMin, companyId, postedWithin, salaryMin, includeHardNo, sort, limit, offset } = filters;

  // Build WHERE
  const { where, binds } = buildJobWhere(filters);

  const orderBy =
    sort === "recent"    ? "j.first_seen_at DESC" :
    sort === "company"   ? "c.name ASC, jf.score DESC" :
    sort === "posted"    ? "COALESCE(j.posted_at, j.first_seen_at) DESC, COALESCE(jf.score, 0) DESC" :
    sort === "salary"    ? "COALESCE(j.salary_max, j.salary_min, 0) DESC, COALESCE(jf.score, 0) DESC, j.first_seen_at DESC" :
                           "COALESCE(jf.score, 0) DESC, j.first_seen_at DESC";

  const sql = `
    SELECT
      j.id, j.title, j.url, j.department, j.team, j.location, j.remote_policy,
      j.employment_type, j.salary_min, j.salary_max, j.salary_currency,
      j.posted_at, j.first_seen_at, j.last_seen_at, j.is_active, j.source_kind,
      c.id AS company_id, c.name AS company_name, c.slug AS company_slug,
      c.industry, c.hq_country, c.hq_state, c.careers_url,
      jf.score, jf.reasons, jf.hard_no, jf.hard_no_reason, jf.profile_version
    FROM job j
    JOIN company c ON c.id = j.company_id
    LEFT JOIN job_fit jf ON jf.job_id = j.id
    WHERE ${where.join(" AND ")}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `;
  const items = await db.prepare(sql).bind(...binds, limit, offset).all().catch((e) => ({ error: e.message, results: [] }));
  // Count query must join job_fit too — otherwise the WHERE clause referencing
  // jf.score/hard_no produces a SQL error and the count silently returns 0.
  const count = await db.prepare(`
    SELECT COUNT(*) AS n
    FROM job j
    JOIN company c ON c.id = j.company_id
    LEFT JOIN job_fit jf ON jf.job_id = j.id
    WHERE ${where.join(" AND ")}
  `).bind(...binds).first().catch((e) => ({ n: 0, error: e.message }));

  // Parse JSON reasons column
  const rows = (items.results || []).map((r) => ({
    ...r,
    reasons: safeJson(r.reasons, []),
    hard_no: !!r.hard_no,
  }));

  // Industry facets
  const facets = await db.prepare(`
    SELECT c.industry, COUNT(j.id) AS n
    FROM job j JOIN company c ON c.id = j.company_id
    WHERE j.is_active = 1
    GROUP BY c.industry ORDER BY n DESC LIMIT 50
  `).all().catch(() => ({ results: [] }));

  return json({
    ok: true,
    items: rows,
    total: count?.n ?? 0,
    facets: facets.results || [],
    sort, fit_min: fitMin, q, industry, remote,
    engagement, posted_within: postedWithin, salary_min: salaryMin,
    updated_at: new Date().toISOString(),
  }, 200, request, env);
}

function safeJson(s, fb) { try { return JSON.parse(s); } catch { return fb; } }

export function readJobFilters(url) {
  return {
    q: (url.searchParams.get("q") || "").trim(),
    industry: (url.searchParams.get("industry") || "").trim(),
    remote: (url.searchParams.get("remote") || "").trim(),
    engagement: (url.searchParams.get("engagement") || "").trim(),
    fitMin: clampInt(url.searchParams.get("fit_min"), 0, 100, 0),
    companyId: clampInt(url.searchParams.get("company_id"), 0, Number.MAX_SAFE_INTEGER, 0),
    postedWithin: clampInt(url.searchParams.get("posted_within"), 0, 3650, 0),
    salaryMin: clampInt(url.searchParams.get("salary_min"), 0, 10_000_000, 0),
    includeHardNo: url.searchParams.get("include_hard_no") === "1",
    sort: url.searchParams.get("sort") || "fit",
    limit: clampInt(url.searchParams.get("limit"), 1, 100, 50),
    offset: clampInt(url.searchParams.get("offset"), 0, Number.MAX_SAFE_INTEGER, 0),
  };
}

export function buildJobWhere(filters) {
  const { q, industry, remote, engagement, fitMin, companyId, postedWithin, salaryMin, includeHardNo } = filters;
  const where = ["j.is_active = 1"];
  const binds = [];

  if (q) {
    where.push("(LOWER(j.title) LIKE ? OR LOWER(j.description_text) LIKE ? OR LOWER(c.name) LIKE ?)");
    const qn = `%${q.toLowerCase()}%`;
    binds.push(qn, qn, qn);
  }
  if (industry) { where.push("c.industry = ?"); binds.push(industry); }
  if (remote) { where.push("j.remote_policy = ?"); binds.push(remote); }
  if (engagement === "contract") {
    where.push("LOWER(COALESCE(j.employment_type, '')) IN ('contract', 'contractor', 'freelance', 'temporary', '1099', 'c2c')");
  } else if (engagement === "employee") {
    where.push("LOWER(COALESCE(j.employment_type, '')) IN ('full_time', 'full-time', 'full time', 'fulltime', 'regular', 'permanent')");
  }
  if (companyId > 0) { where.push("j.company_id = ?"); binds.push(companyId); }
  if (postedWithin > 0) {
    where.push("COALESCE(j.posted_at, j.first_seen_at) IS NOT NULL AND julianday(COALESCE(j.posted_at, j.first_seen_at)) > julianday('now', ?)");
    binds.push(`-${postedWithin} day`);
  }
  if (salaryMin > 0) {
    where.push("COALESCE(j.salary_min, j.salary_max, 0) >= ?");
    binds.push(salaryMin);
  }
  if (!includeHardNo) where.push("(jf.hard_no IS NULL OR jf.hard_no = 0)");
  // A minimum fit score should not leak unscored jobs into the results.
  if (fitMin > 0) { where.push("jf.score >= ?"); binds.push(fitMin); }

  return { where, binds };
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}
