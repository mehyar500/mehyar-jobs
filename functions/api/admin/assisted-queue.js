// GET /api/admin/assisted-queue
//
//   "Today's queue" — the in-app replacement for the email
//   notification. Returns applications with status='auto_submitted_pending'
//   (i.e. the assisted-fallback path finished, but the user still needs
//   to click submit on the company's site).
//
//   Each entry includes:
//     - job title + URL to open
//     - prepared form_filled values + LLM-drafted answers
//     - email_status (what would have been sent in the email)
//     - tracking_email + the email-worker activity (has the company replied?)
//
//   This is what shows up in the dashboard so the user always sees
//   "you have N things to do today" without needing email.

import { requireAdmin, json, corsHeaders, onRequestOptions } from "../../_shared/adminAuth.js";
import { ensureSchema } from "../../_shared/db.js";

export { onRequestOptions as onRequest };

export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);

  const url = new URL(request.url);
  const include_done = url.searchParams.get("include_done") === "1";
  const limit = Math.min(100, parseInt(url.searchParams.get("limit") || "50", 10));

  // Pick up all "pending" applications + (optionally) recent completions.
  // Assisted path leaves status='auto_submitted_pending' until the user
  // clicks submit OR company replies to the tracking address.
  const where = include_done
    ? `WHERE a.status IN ('auto_submitted_pending','draft','submitted','confirmed')`
    : `WHERE a.status = 'auto_submitted_pending'`;

  const rows = (await env.JOBS_DB.prepare(`
    SELECT
      a.id               AS app_id,
      a.job_id           AS job_id,
      a.status           AS status,
      a.submission_method AS submission_method,
      a.tracking_email   AS tracking_email,
      a.submission_url   AS submission_url,
      a.cover_letter_sent AS cover_letter_sent,
      a.custom_answers_sent AS custom_answers_sent,
      a.fields_filled_json AS fields_filled_json,
      a.application_method AS application_method,
      a.email_sent_at    AS email_sent_at,
      a.email_id         AS email_id,
      a.submitted_at     AS submitted_at,
      a.notes            AS notes,
      a.created_at       AS created_at,
      a.updated_at       AS updated_at,
      j.title            AS job_title,
      j.url              AS job_url,
      j.location         AS job_location,
      j.remote_policy    AS job_remote_policy,
      j.department       AS job_department,
      j.posted_at        AS job_posted_at,
      c.id               AS company_id,
      c.name             AS company_name,
      c.slug             AS company_slug,
      c.industry         AS company_industry,
      jf.score           AS fit_score,
      jf.reasons         AS fit_reasons
    FROM application a
    JOIN job j ON j.id = a.job_id
    JOIN company c ON c.id = j.company_id
    LEFT JOIN job_fit jf ON jf.job_id = j.id
    ${where}
    ORDER BY (a.email_sent_at IS NULL) ASC, COALESCE(a.email_sent_at, a.updated_at) DESC, a.id DESC
    LIMIT ?
  `).bind(limit).all().catch((e) => ({ results: [], error: e.message }))).results || [];

  // For each pending app, pull the most recent auto_submit event with form_filled data
  const enriched = await Promise.all(rows.map(async (r) => {
    // Latest run that has the LLM/form_filled details
    const lastRun = await env.JOBS_DB.prepare(`
      SELECT id, kind, detail, created_at
      FROM application_event
      WHERE application_id = ? AND kind IN ('assisted_run_finished','auto_submit_started','auto_apply_top','email_sent','email_failed')
      ORDER BY id DESC LIMIT 10
    `).bind(r.app_id).all().catch(() => ({ results: [] }));

    const events = (lastRun.results || []).map((ev) => {
      let detail = null;
      try { detail = JSON.parse(ev.detail || "{}"); } catch { detail = ev.detail; }
      return { at: ev.created_at, kind: ev.kind, detail };
    });

    // Pick the most recent assisted_run_finished for form_filled data
    const assisted = events.find((e) => e.kind === "assisted_run_finished");
    const email_ev = events.find((e) => e.kind === "email_sent" || e.kind === "email_failed");

    let form_filled = {};
    try { form_filled = JSON.parse(r.fields_filled_json || "{}"); } catch { form_filled = {}; }
    let custom_answers = [];
    try { custom_answers = JSON.parse(r.custom_answers_sent || "[]"); } catch { custom_answers = []; }

    return {
      app_id: r.app_id,
      job_id: r.job_id,
      status: r.status,
      submission_method: r.submission_method,
      job: {
        id: r.job_id,
        title: r.job_title,
        url: r.submission_url || r.job_url,
        location: r.job_location,
        remote_policy: r.job_remote_policy,
        department: r.job_department,
        posted_at: r.job_posted_at,
      },
      company: {
        id: r.company_id,
        name: r.company_name,
        slug: r.company_slug,
        industry: r.company_industry,
      },
      fit: {
        score: r.fit_score,
        reasons: (() => { try { return JSON.parse(r.fit_reasons || "[]"); } catch { return []; } })(),
      },
      tracking_email: r.tracking_email || (r.app_id ? `app-${shortId(r.app_id)}@jobs.mehyar.us` : null),
      cover_letter_excerpt: r.cover_letter_sent ? r.cover_letter_sent.slice(0, 200) : "",
      form_filled,
      custom_answers,
      last_event_at: r.updated_at,
      email: {
        attempted: !!r.email_sent_at || !!email_ev,
        sent_at: r.email_sent_at,
        id: r.email_id,
        last_status: email_ev?.kind === "email_sent" ? "sent" : email_ev?.kind === "email_failed" ? "failed" : r.email_sent_at ? "sent" : "not_attempted",
        last_error: email_ev?.detail?.error || email_ev?.detail?.reason || null,
      },
      events,
    };
  }));

  return json({
    ok: true,
    count: enriched.length,
    pending_count: enriched.filter((e) => e.status === "auto_submitted_pending").length,
    submitted_count: enriched.filter((e) => e.status === "submitted" || e.status === "confirmed").length,
    items: enriched,
    message: `${enriched.filter((e) => e.status === "auto_submitted_pending").length} pending — open each job URL and click submit. They will be marked confirmed when the company replies.`,
  }, 200, request, env);
}

function shortId(id) {
  // Match the shortId mapping used by inbound.js: take the last 6 chars of id,
  // base36-lowercased. The DB doesn't store the encoded shortId; the inbound
  // lookup does tracking_email = "app-XXXX@jobs.mehyar.us", so we just show
  // a placeholder for the user.
  const s = (id >>> 0).toString(36).toLowerCase();
  return s.slice(-6).padStart(6, "0");
}
