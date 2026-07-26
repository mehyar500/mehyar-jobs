// GET /api/public/profile  → no auth, returns the user's profile (used by fit logic on shared endpoints)
// GET /api/public/stats    → no auth, returns public stats (companies, jobs, scraped-at)
// GET /api/health          → no auth, health probe

import { json, corsHeaders, onRequestOptions } from "../../_shared/adminAuth.js";

export { onRequestOptions as onRequest };

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/api\/public\/?/, "");

  if (path === "health" || url.pathname.endsWith("/api/public/health")) {
    const ok = !!env?.JOBS_DB;
    return json({ ok, db: !!env?.JOBS_DB, ts: new Date().toISOString() }, 200, request, env);
  }

  if (path === "stats" || url.pathname.endsWith("/api/public/stats")) {
    const db = env?.JOBS_DB;
    if (!db) return json({ ok: false, error: "no_db" }, 500, request, env);
    const counts = await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM company) AS companies,
        (SELECT COUNT(*) FROM job WHERE is_active = 1) AS jobs,
        (SELECT MAX(scrape_last_at) FROM company) AS last_scrape_at,
        (SELECT COUNT(*) FROM scrape_run) AS scrape_runs
    `).first().catch(() => ({ companies: 0, jobs: 0, last_scrape_at: null, scrape_runs: 0 }));
    return json({ ok: true, ...counts, ts: new Date().toISOString() }, 200, request, env);
  }

  return json({ ok: false, error: "not_found", path }, 404, request, env);
}