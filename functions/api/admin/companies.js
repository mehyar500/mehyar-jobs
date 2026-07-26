// GET /api/admin/companies?industry=&q=&scrape_status=&limit=&offset=

import { requireAdmin, json, corsHeaders, onRequestOptions } from "../../_shared/adminAuth.js";
import { ensureSchema } from "../../_shared/db.js";

export { onRequestOptions as onRequest };

export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);

  await ensureSchema(env);
  const url = new URL(request.url);
  const industry = (url.searchParams.get("industry") || "").trim();
  const q = (url.searchParams.get("q") || "").trim();
  const status = (url.searchParams.get("scrape_status") || "").trim();
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") || "100", 10)));
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10));

  const where = [];
  const binds = [];
  if (industry) { where.push("industry = ?"); binds.push(industry); }
  if (q) { where.push("(LOWER(name) LIKE ? OR LOWER(slug) LIKE ? OR LOWER(careers_url) LIKE ?)"); const qn = "%" + q.toLowerCase() + "%"; binds.push(qn, qn, qn); }
  if (status) { where.push("scrape_status = ?"); binds.push(status); }

  const sql = `SELECT id, name, slug, ticker, source, source_rank, industry, hq_country, hq_state, careers_url, careers_kind, careers_handle, scrape_status, scrape_last_at, scrape_error, jobs_count, created_at, updated_at FROM company ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY jobs_count DESC, name ASC LIMIT ? OFFSET ?`;
  const items = await env.JOBS_DB.prepare(sql).bind(...binds, limit, offset).all().catch(() => ({ results: [] }));

  const facets = await env.JOBS_DB.prepare(`
    SELECT industry, COUNT(*) AS n FROM company GROUP BY industry ORDER BY n DESC LIMIT 50
  `).all().catch(() => ({ results: [] }));

  const total = await env.JOBS_DB.prepare(`SELECT COUNT(*) AS n FROM company ${where.length ? "WHERE " + where.join(" AND ") : ""}`).bind(...binds).first().catch(() => ({ n: 0 }));

  return json({
    ok: true,
    items: items.results || [],
    total: total?.n || 0,
    facets: facets.results || [],
  }, 200, request, env);
}