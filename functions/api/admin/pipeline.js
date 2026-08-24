// GET /api/admin/pipeline
//
// A compact operational view for the remote dashboard and the local runner.

import { requireAdmin, json, onRequestOptions } from "../../_shared/adminAuth.js";
import { ensureSchema } from "../../_shared/db.js";

export { onRequestOptions as onRequest };

export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);

  await ensureSchema(env);
  const db = env.JOBS_DB;
  const all = await Promise.all([
    db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active FROM job").first(),
    db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN scrape_status = 'broken' THEN 1 ELSE 0 END) AS broken, MAX(scrape_last_at) AS last_scrape_at FROM company").first(),
    db.prepare("SELECT COUNT(*) AS scored, SUM(CASE WHEN score >= 70 AND hard_no = 0 THEN 1 ELSE 0 END) AS ready, SUM(CASE WHEN hard_no = 1 THEN 1 ELSE 0 END) AS hard_no, MAX(scored_at) AS last_scored_at FROM job_fit").first(),
    db.prepare("SELECT status, COUNT(*) AS count FROM application GROUP BY status").all(),
    db.prepare("SELECT status, COUNT(*) AS count FROM application_queue GROUP BY status").all(),
    db.prepare("SELECT day, submitted, succeeded, failed FROM daily_counter WHERE day = ?").bind(new Date().toISOString().slice(0, 10)).first(),
    db.prepare("SELECT id, started_at, finished_at, companies_attempted, companies_succeeded, companies_failed, jobs_found, new_jobs, removed_jobs, duration_ms FROM scrape_run ORDER BY id DESC LIMIT 5").all(),
    db.prepare("SELECT id, status, started_at, finished_at, error FROM auto_submit_run ORDER BY id DESC LIMIT 5").all(),
    db.prepare("SELECT id, received_at, from_addr, subject, matched_application_id FROM email_inbound ORDER BY id DESC LIMIT 5").all(),
    db.prepare("SELECT COUNT(*) AS contract_jobs FROM job WHERE is_active = 1 AND LOWER(COALESCE(employment_type, '')) IN ('contract', 'contractor', 'freelance', 'temporary')").first(),
    db.prepare("SELECT scan_day, cursor, completed_at, last_error, updated_at FROM scan_scheduler_state WHERE name = 'daily-company-scan'").first().catch(() => null),
  ]);

  const [jobs, companies, scores, applications, queue, today, scrapeRuns, autoRuns, inbound, engagement, scheduler] = all;
  return json({
    ok: true,
    generated_at: new Date().toISOString(),
    jobs: jobs || { total: 0, active: 0 },
    companies: companies || { total: 0, broken: 0, last_scrape_at: null },
    scores: scores || { scored: 0, ready: 0, hard_no: 0, last_scored_at: null },
    applications: applications?.results || [],
    queue: queue?.results || [],
    today: today || { submitted: 0, succeeded: 0, failed: 0 },
    scrape_runs: scrapeRuns?.results || [],
    auto_submit_runs: autoRuns?.results || [],
    inbound_email: inbound?.results || [],
    engagement: engagement || { contract_jobs: 0 },
    scheduler: scheduler || null,
  }, 200, request, env);
}
