// /api/admin/applications/{id}/submit
//   POST → mark application submitted + send confirmation email
//
// Most ATSs do not have a public submit API. We treat all submissions
// as "external_link" and record the canonical URL. The email is the
// user's confirmation — they click the link in the email (or in the
// SPA), use the prepared cover letter + answers to fill in the form,
// and the actual ATS submission happens there.

import { requireAdmin, json, corsHeaders, onRequestOptions } from "../../../../_shared/adminAuth.js";
import { ensureSchema } from "../../../../_shared/db.js";
import { loadProfile } from "../../../../_shared/fit.js";
import { sendEmail, renderApplicationEmail } from "../../../../_shared/email.js";

export { onRequestOptions as onRequest };

export async function onRequestPost({ request, env, params }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);
  const id = parseInt(params?.id, 10);
  if (!id) return json({ ok: false, error: "id_required" }, 400, request, env);

  const app = await env.JOBS_DB.prepare(`
    SELECT a.*, j.title AS job_title, j.url AS job_url, j.location AS job_location, j.remote_policy AS job_remote_policy,
           jf.score AS job_score,
           c.id AS company_id, c.name AS company_name, c.slug AS company_slug, c.industry AS company_industry,
           c.careers_url AS company_careers_url
    FROM application a
    JOIN job j     ON j.id = a.job_id
    JOIN company c ON c.id = j.company_id
    LEFT JOIN job_fit jf ON jf.job_id = j.id
    WHERE a.id = ?
  `).bind(id).first();
  if (!app) return json({ ok: false, error: "not_found" }, 404, request, env);

  if (app.status === "submitted") {
    return json({ ok: false, error: "already_submitted", submitted_at: app.submitted_at }, 400, request, env);
  }

  const now = new Date().toISOString();
  const submissionUrl = app.job_url || app.company_careers_url;

  await env.JOBS_DB.prepare(`
    UPDATE application
    SET status = 'submitted', submission_method = 'external_link', submission_url = ?, submitted_at = ?, updated_at = ?
    WHERE id = ?
  `).bind(submissionUrl, now, now, id).run();
  await env.JOBS_DB.prepare("INSERT INTO application_event (application_id, kind, detail) VALUES (?, 'submitted', ?)")
    .bind(id, JSON.stringify({ method: "external_link", url: submissionUrl, at: now })).run().catch(() => null);

  const profile = await loadProfile(env);
  const { subject, text, html } = renderApplicationEmail({
    application: { id, submitted_at: now, submission_url: submissionUrl, submission_method: "external_link" },
    job: { title: app.job_title, location: app.job_location, remote_policy: app.job_remote_policy, score: app.job_score, url: app.job_url },
    company: { name: app.company_name, industry: app.company_industry },
    profile,
  });
  const recipient = env?.NOTIFY_EMAIL || env?.USER_EMAIL;
  const emailResult = await sendEmail(env, { to: recipient, subject, text, html });

  if (emailResult.ok) {
    await env.JOBS_DB.prepare("UPDATE application SET email_sent_at = ?, email_id = ? WHERE id = ?")
      .bind(now, emailResult.id || null, id).run();
    await env.JOBS_DB.prepare("INSERT INTO application_event (application_id, kind, detail) VALUES (?, 'email_sent', ?)")
      .bind(id, JSON.stringify({ provider: emailResult.provider, id: emailResult.id })).run().catch(() => null);
  } else {
    await env.JOBS_DB.prepare("INSERT INTO application_event (application_id, kind, detail) VALUES (?, 'email_failed', ?)")
      .bind(id, JSON.stringify({ error: emailResult.error })).run().catch(() => null);
  }

  return json({
    ok: true, id, status: "submitted", submitted_at: now, submission_url: submissionUrl,
    email: { sent: emailResult.ok, error: emailResult.error || null, recipient: recipient || null },
  }, 200, request, env);
}
