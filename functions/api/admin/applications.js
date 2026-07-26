// /api/admin/applications — collection + draft creation
//   GET  /                     → list user's applications (latest first)
//   POST /                     → create a draft application for a job
//
// /api/admin/applications/[id]  — single application CRUD
//   GET    /api/admin/applications/{id}        → fetch + join job + company + events
//   PATCH  /api/admin/applications/{id}        → update cover_letter / custom_answers / notes / status
//   DELETE /api/admin/applications/{id}        → withdraw (soft delete; sets status="withdrawn")
//
// /api/admin/applications/[id]/submit
//   POST /api/admin/applications/{id}/submit   → mark submitted + send email
//
// /api/admin/applications/[id]/events
//   GET  /api/admin/applications/{id}/events   → audit trail

import { requireAdmin, json, corsHeaders, onRequestOptions } from "../../_shared/adminAuth.js";
import { ensureSchema } from "../../_shared/db.js";
import { loadProfile } from "../../_shared/fit.js";
import { generateCoverLetter, generateCustomAnswers, matchCustomQuestions, extractQuestions } from "../../_shared/coverLetter.js";
import { sendEmail, renderApplicationEmail } from "../../_shared/email.js";
import { extractSalary } from "../../_shared/salary.js";

export { onRequestOptions as onRequest };

export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);

  await ensureSchema(env);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "";

  const where = ["1=1"];
  const binds = [];
  if (status === "confirmed") {
    // special: applications the company has confirmed receipt of
    where.push("a.company_confirmed_at IS NOT NULL");
  } else if (status === "unconfirmed") {
    // submitted but no company reply yet
    where.push("a.status = 'submitted' AND a.company_confirmed_at IS NULL");
  } else if (status === "no_reply_3d") {
    // submitted 3+ days ago, no company reply
    where.push("a.status = 'submitted' AND a.company_confirmed_at IS NULL AND julianday('now') - julianday(a.submitted_at) >= 3");
  } else if (status) {
    where.push("a.status = ?");
    binds.push(status);
  }

    const sql = `
    SELECT
      a.id, a.job_id, a.status, a.cover_letter, a.custom_answers, a.notes,
      a.submission_method, a.submission_url, a.created_at, a.updated_at, a.submitted_at,
      a.email_sent_at, a.email_id,
      a.company_confirmed_at, a.company_confirmed_source, a.company_email_subject,
      a.tracking_email, a.next_action_at, a.follow_up_count,
      a.salary_min_job, a.salary_max_job, a.salary_currency_job,
      a.cover_letter_sent, a.custom_answers_sent, a.fields_filled_json,
      a.application_method, a.external_url,
      jf.score AS job_score,
      j.title AS job_title, j.url AS job_url, j.location AS job_location,
      j.remote_policy AS job_remote_policy,
      c.id AS company_id, c.name AS company_name, c.slug AS company_slug,
      c.industry AS company_industry, c.careers_url AS company_careers_url
    FROM application a
    JOIN job j     ON j.id = a.job_id
    JOIN company c ON c.id = j.company_id
    LEFT JOIN job_fit jf ON jf.job_id = j.id
    WHERE ${where.join(" AND ")}
    ORDER BY a.updated_at DESC
    LIMIT 500
  `;
  const rows = (await env.JOBS_DB.prepare(sql).bind(...binds).all().catch(() => ({ results: [] }))).results || [];
  return json({ ok: true, items: rows.map((r) => ({ ...r, custom_answers: safeJson(r.custom_answers, {}) })) }, 200, request, env);
}

export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);

  await ensureSchema(env);
  let body = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400, request, env); }
  const jobId = parseInt(body.job_id, 10);
  if (!jobId) return json({ ok: false, error: "job_id_required" }, 400, request, env);

  // Fetch job + company + profile in one go
  const job = await env.JOBS_DB.prepare(`
    SELECT j.*, c.name AS company_name, c.industry, c.hq_country, c.hq_state, c.slug AS company_slug, c.careers_url
    FROM job j JOIN company c ON c.id = j.company_id
    WHERE j.id = ?
  `).bind(jobId).first();
  if (!job) return json({ ok: false, error: "job_not_found" }, 404, request, env);

  const profile = await loadProfile(env);
  const company = { name: job.company_name, industry: job.industry, hq_country: job.hq_country, hq_state: job.hq_state };
  const coverLetter = body.cover_letter || generateCoverLetter({ profile, job, company });
  const canonicalAnswers = generateCustomAnswers({ profile, job, company });
  const questions = extractQuestions(job.description_text || "");
  const matchedAnswers = matchCustomQuestions(questions, canonicalAnswers);
  // Include all canonical answers in the map for completeness; user can override per-question
  const customAnswers = body.custom_answers || { ...Object.fromEntries(matchedAnswers.map((m) => [m.q, m.a])), ...canonicalAnswers };
  // The tracking email is the address the company will use to reply
  // (which is then auto-detected by /api/email/inbound). The user
  // can override it per-application if they want a real personal
  // email there instead.
  const trackingEmail = body.tracking_email || generateTrackingEmail();
  // Salary extracted from the job description (if present).
  const salary = extractSalary(job.description_text || "");

  // Upsert: one application per job
  let id;
  try {
    const existing = await env.JOBS_DB.prepare("SELECT id FROM application WHERE job_id = ?").bind(jobId).first();
    if (existing) {
      const upd = await env.JOBS_DB.prepare(`
        UPDATE application
        SET cover_letter = ?,
            custom_answers = ?,
            tracking_email = COALESCE(?, tracking_email),
            salary_min_job = COALESCE(?, salary_min_job),
            salary_max_job = COALESCE(?, salary_max_job),
            salary_currency_job = COALESCE(?, salary_currency_job),
            updated_at = datetime('now'),
            status = CASE WHEN status = 'submitted' OR status = 'submitting' THEN status ELSE 'draft' END
        WHERE id = ?
      `).bind(coverLetter, JSON.stringify(customAnswers), trackingEmail, salary?.min ?? null, salary?.max ?? null, salary?.currency ?? null, existing.id).run();
      id = existing.id;
    } else {
      const ins = await env.JOBS_DB.prepare(`
        INSERT INTO application (job_id, status, cover_letter, custom_answers, tracking_email, salary_min_job, salary_max_job, salary_currency_job)
        VALUES (?, 'draft', ?, ?, ?, ?, ?, ?)
      `).bind(jobId, coverLetter, JSON.stringify(customAnswers), trackingEmail, salary?.min ?? null, salary?.max ?? null, salary?.currency ?? null).run();
      id = ins?.meta?.last_row_id;
    }
  } catch (e) {
    console.log("applications.js POST upsert error:", String(e?.message || e));
    return json({ ok: false, error: "upsert_failed", detail: String(e?.message || e) }, 500, request, env);
  }
  try {
    await env.JOBS_DB.prepare("INSERT INTO application_event (application_id, kind, detail) VALUES (?, ?, ?)")
      .bind(id, "created", `draft for job ${jobId}`).run();
  } catch {}

  return json({
    ok: true,
    id,
    cover_letter: coverLetter,
    custom_answers: customAnswers,
    matched_questions: matchedAnswers,
    canonical_answers: canonicalAnswers,
    questions_found: questions.length,
  }, 200, request, env);
}

function safeJson(s, fb) { try { return JSON.parse(s); } catch { return fb; } }

function generateTrackingEmail() {
  // Generate a per-draft tracking address: app-{shortId}@jobs.mehyar.us.
  // shortId is a 6-char base36 random. The user can override per app.
  // The email worker /api/email/inbound matches on the local-part to
  // route the company's reply back to the right application.
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 6; i++) id += chars[bytes[i] % chars.length];
  return `app-${id}@jobs.mehyar.us`;
}
