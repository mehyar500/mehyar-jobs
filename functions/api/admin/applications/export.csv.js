// /api/admin/applications/export.csv
//
// Returns every application as CSV. The user's local record of what
// they applied to, in case the app goes down or they need to share
// it with someone (recruiter, career coach, etc.).
//
// Columns:
//   id, status, job_title, company_name, job_url, job_location,
//   remote_policy, fit_score, applied_at, company_confirmed_at,
//   days_since_submit, days_to_confirm, submission_method,
//   submission_url, cover_letter_excerpt, notes

import { requireAdmin, json, corsHeaders, onRequestOptions } from "../../../_shared/adminAuth.js";
import { ensureSchema } from "../../../_shared/db.js";

export { onRequestOptions as onRequest };

function csvEscape(s) {
  if (s == null) return "";
  const v = String(s);
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);

  const rows = (await env.JOBS_DB.prepare(`
    SELECT
      a.id, a.status, a.created_at, a.updated_at, a.submitted_at, a.company_confirmed_at,
      a.submission_method, a.submission_url, a.cover_letter, a.notes, a.follow_up_count,
      
      j.id AS job_id, j.title AS job_title, j.url AS job_url, j.location AS job_location,
      j.remote_policy AS job_remote_policy, jf.score AS current_fit_score,
      c.id AS company_id, c.name AS company_name, c.industry AS company_industry,
      c.careers_url AS company_careers_url
    FROM application a
    JOIN job j     ON j.id = a.job_id
    JOIN company c ON c.id = j.company_id
    LEFT JOIN job_fit jf ON jf.job_id = j.id
    ORDER BY a.updated_at DESC
  `).all().catch(() => ({ results: [] }))).results || [];

  const cols = [
    "id","status","created_at","updated_at","submitted_at","company_confirmed_at",
    "days_since_submit","days_to_confirm",
    "job_id","job_title","company_name","company_industry",
    "job_location","job_remote_policy","fit_score",
    "submission_method","submission_url",
    "job_url","cover_letter_excerpt","notes","follow_up_count"
  ];

  const lines = [cols.join(",")];
  const now = Date.now();
  for (const r of rows) {
    const submittedMs = r.submitted_at ? Date.parse(r.submitted_at) : null;
    const confirmedMs = r.company_confirmed_at ? Date.parse(r.company_confirmed_at) : null;
    const days_since_submit = submittedMs ? Math.floor((now - submittedMs) / 86400000) : "";
    const days_to_confirm    = (submittedMs && confirmedMs) ? Math.floor((confirmedMs - submittedMs) / 86400000) : "";
    const excerpt = r.cover_letter ? r.cover_letter.slice(0, 280).replace(/\n/g, " ⏎ ") : "";
    const row = [
      r.id, r.status, r.created_at, r.updated_at, r.submitted_at, r.company_confirmed_at,
      days_since_submit, days_to_confirm,
      r.job_id, r.job_title, r.company_name, r.company_industry,
      r.job_location, r.job_remote_policy, r.current_fit_score ?? r.job_fit_score_at_apply,
      r.submission_method, r.submission_url,
      r.job_url, excerpt, r.notes, r.follow_up_count,
    ];
    lines.push(row.map(csvEscape).join(","));
  }

  const csv = lines.join("\n");
  const filename = `mehyar-jobs-applications-${new Date().toISOString().slice(0,10)}.csv`;
  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
      ...corsHeaders(request, env),
    },
  });
}
