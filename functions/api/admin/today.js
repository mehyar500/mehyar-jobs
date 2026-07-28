// GET  /api/admin/today?days=7
//   → today's snapshot for the "Today" landing page:
//       - scrape_run summary (last run + counts)
//       - new_today   : jobs whose first_seen_at falls in the window, joined with company + fit, with application status if any
//       - submitted   : applications with status='submitted', ordered by submitted_at desc
//       - not_submitted: today's new jobs that DO NOT have an application row (or the row is draft)
//       - submitted_today / submitted_this_week counters
//     All in one round-trip, paged.
//
// POST /api/admin/jobs/{id}/mark  body: { action: "applied" | "skipped" | "applied_external", url?: string, note?: string }
//   → upsert an application row for the given job_id with status='submitted' and submission_method=manual|external_link
//   → records an application_event audit row
//
// Both endpoints require admin auth (same JWT as mehyar-web).

import { requireAdmin, json, onRequestOptions } from "../../_shared/adminAuth.js";
import { ensureSchema } from "../../_shared/db.js";

export { onRequestOptions as onRequest };

export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);

  await ensureSchema(env);
  const db = env.JOBS_DB;

  const url = new URL(request.url);
  const days = Math.min(30, Math.max(1, parseInt(url.searchParams.get("days") || "7", 10)));
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") || "100", 10)));

  // ---- 1. last scrape run summary ----
  const lastRun = await db.prepare(`
    SELECT id, started_at, finished_at, companies_attempted, companies_succeeded,
           companies_failed, jobs_found, new_jobs, removed_jobs, trigger, duration_ms
    FROM scrape_run
    ORDER BY id DESC LIMIT 1
  `).first().catch(() => null);

  // ---- 2. new today: jobs first seen within window ----
  const newToday = await db.prepare(`
    SELECT
      j.id, j.title, j.url, j.location, j.remote_policy, j.department,
      j.first_seen_at, j.last_seen_at, j.posted_at, j.salary_min, j.salary_max,
      c.id AS company_id, c.name AS company_name, c.slug AS company_slug, c.industry,
      jf.score, jf.hard_no,
      a.id AS application_id, a.status AS application_status, a.submission_method,
      a.submitted_at
    FROM job j
    JOIN company c ON c.id = j.company_id
    LEFT JOIN job_fit jf ON jf.job_id = j.id
    LEFT JOIN application a ON a.job_id = j.id
    WHERE j.is_active = 1
      AND julianday(j.first_seen_at) > julianday('now', ?)
    ORDER BY j.first_seen_at DESC
    LIMIT ?
  `).bind(`-${days} day`, limit).all().catch((e) => ({ results: [], error: e.message }));

  // ---- 3. not submitted: same window, NO submitted application ----
  //    (drafts count as not-submitted — show them so the user can decide)
  const notSubmitted = await db.prepare(`
    SELECT
      j.id, j.title, j.url, j.location, j.remote_policy, j.department,
      j.first_seen_at, j.posted_at,
      c.id AS company_id, c.name AS company_name, c.slug AS company_slug, c.industry,
      jf.score, jf.hard_no,
      a.id AS application_id, a.status AS application_status
    FROM job j
    JOIN company c ON c.id = j.company_id
    LEFT JOIN job_fit jf ON jf.job_id = j.id
    LEFT JOIN application a ON a.job_id = j.id
    WHERE j.is_active = 1
      AND julianday(j.first_seen_at) > julianday('now', ?)
      AND (a.id IS NULL OR a.status IN ('draft','failed'))
    ORDER BY jf.score DESC NULLS LAST, j.first_seen_at DESC
    LIMIT ?
  `).bind(`-${days} day`, limit).all().catch((e) => ({ results: [], error: e.message }));

  // ---- 4. submitted: any application with status='submitted', recent first ----
  const submitted = await db.prepare(`
    SELECT
      a.id, a.status, a.submission_method, a.submitted_at, a.tracking_email,
      a.company_confirmed_at, a.company_confirmed_source,
      j.id AS job_id, j.title, j.url, j.location, j.remote_policy,
      c.id AS company_id, c.name AS company_name, c.slug AS company_slug, c.industry,
      jf.score
    FROM application a
    JOIN job j       ON j.id = a.job_id
    JOIN company c   ON c.id = j.company_id
    LEFT JOIN job_fit jf ON jf.job_id = j.id
    WHERE a.status = 'submitted'
    ORDER BY a.submitted_at DESC
    LIMIT ?
  `).bind(limit).all().catch((e) => ({ results: [], error: e.message }));

  // ---- 5. counters ----
  const submittedToday = await db.prepare(`
    SELECT COUNT(*) AS n FROM application
    WHERE status = 'submitted'
      AND julianday(submitted_at) > julianday('now', '-1 day')
  `).first().catch(() => ({ n: 0 }));

  const submittedWeek = await db.prepare(`
    SELECT COUNT(*) AS n FROM application
    WHERE status = 'submitted'
      AND julianday(submitted_at) > julianday('now', ?)
  `).bind(`-${days} day`).first().catch(() => ({ n: 0 }));

  const totalActive = await db.prepare(`SELECT COUNT(*) AS n FROM job WHERE is_active = 1`).first().catch(() => ({ n: 0 }));

  return json({
    ok: true,
    window_days: days,
    updated_at: new Date().toISOString(),
    last_run: lastRun || null,
    counters: {
      total_active: totalActive?.n || 0,
      new_in_window: (newToday.results || []).length,
      not_submitted: (notSubmitted.results || []).length,
      submitted_today: submittedToday?.n || 0,
      submitted_this_window: submittedWeek?.n || 0,
    },
    new_today:      newToday.results    || [],
    not_submitted:  notSubmitted.results || [],
    submitted:      submitted.results   || [],
  }, 200, request, env);
}

// ─────────────────────────── POST: manual mark ───────────────────────────
export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);

  await ensureSchema(env);
  const db = env.JOBS_DB;

  // Parse: /api/admin/today → POST has no path params here, but the
  // companion endpoint /api/admin/jobs/{id}/mark handles that. This
  // file is mounted only for GET (today snapshot). The manual-mark
  // POST lives at functions/api/admin/jobs/[id]/mark.js.
  return json({ ok: false, error: "use_post_mark" }, 405, request, env);
}
