// GET /api/admin/jobs?fit_min=&q=&industry=&remote=&company_id=&posted_within=&limit=&offset=
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
  const q = (url.searchParams.get("q") || "").trim();
  const industry = (url.searchParams.get("industry") || "").trim();
  const remote = (url.searchParams.get("remote") || "").trim();
  const fitMin = Math.max(0, Math.min(100, parseInt(url.searchParams.get("fit_min") || "0", 10)));
  const companyId = url.searchParams.get("company_id") || "";
  const postedWithin = parseInt(url.searchParams.get("posted_within") || "0", 10); // days
  const includeHardNo = url.searchParams.get("include_hard_no") === "1";
  const sort = url.searchParams.get("sort") || "fit"; // fit | recent | company
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10)));
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10));

  // Build WHERE
  const where = ["j.is_active = 1"];
  const binds = [];
  if (q) { where.push("(LOWER(j.title) LIKE ? OR LOWER(j.description_text) LIKE ? OR LOWER(c.name) LIKE ?)"); const qn = "%" + q.toLowerCase() + "%"; binds.push(qn, qn, qn); }
  if (industry) { where.push("c.industry = ?"); binds.push(industry); }
  if (remote) { where.push("j.remote_policy = ?"); binds.push(remote); }
  if (companyId) { where.push("j.company_id = ?"); binds.push(parseInt(companyId, 10)); }
  if (postedWithin > 0) { where.push("j.posted_at IS NOT NULL AND julianday(j.posted_at) > julianday('now', ?)"); binds.push(`-${postedWithin} day`); }
  if (!includeHardNo) { where.push("(jf.hard_no IS NULL OR jf.hard_no = 0)"); }
  if (fitMin > 0) { where.push("(jf.score IS NULL OR jf.score >= ?)"); binds.push(fitMin); }

  const orderBy = sort === "recent" ? "j.first_seen_at DESC" : sort === "company" ? "c.name ASC, jf.score DESC" : "COALESCE(jf.score, 0) DESC, j.first_seen_at DESC";

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
    updated_at: new Date().toISOString(),
  }, 200, request, env);
}

function safeJson(s, fb) { try { return JSON.parse(s); } catch { return fb; } }