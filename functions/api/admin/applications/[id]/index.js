// /api/admin/applications/{id} — single application CRUD
//   GET    /api/admin/applications/{id}            → fetch + join job + company + events
//   PATCH  /api/admin/applications/{id}            → update
//   DELETE /api/admin/applications/{id}            → withdraw
//
// Submit lives at /api/admin/applications/{id}/submit (separate file).

import { requireAdmin, json, corsHeaders, onRequestOptions } from "../../../../_shared/adminAuth.js";
import { ensureSchema } from "../../../../_shared/db.js";

export { onRequestOptions as onRequest };

export async function onRequestGet({ request, env, params }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);
  const id = parseInt(params?.id, 10);
  if (!id) return json({ ok: false, error: "id_required" }, 400, request, env);
  const app = await env.JOBS_DB.prepare(`
    SELECT a.tracking_email, a.cover_letter_sent, a.custom_answers_sent, a.fields_filled_json,
           a.application_method, a.external_url, a.salary_min_job, a.salary_max_job, a.salary_currency_job,
           a.*, jf.score AS job_score,
           j.title AS job_title, j.url AS job_url, j.location AS job_location, j.remote_policy AS job_remote_policy,
           j.department AS job_department, j.description_text AS job_description, j.salary_min, j.salary_max, j.salary_currency,
           j.posted_at AS job_posted_at,
           c.id AS company_id, c.name AS company_name, c.slug AS company_slug, c.industry AS company_industry,
           c.careers_url AS company_careers_url, c.hq_country, c.hq_state
    FROM application a
    JOIN job j     ON j.id = a.job_id
    JOIN company c ON c.id = j.company_id
    LEFT JOIN job_fit jf ON jf.job_id = j.id
    WHERE a.id = ?
  `).bind(id).first();
  if (!app) return json({ ok: false, error: "not_found" }, 404, request, env);

  const events = (await env.JOBS_DB.prepare(`
    SELECT id, kind, detail, created_at FROM application_event
    WHERE application_id = ? ORDER BY created_at DESC LIMIT 50
  `).bind(id).all().catch(() => ({ results: [] }))).results || [];

  return json({
    ok: true,
    application: { ...app, custom_answers: safeJson(app.custom_answers, {}) },
    events,
  }, 200, request, env);
}

export async function onRequestPatch({ request, env, params }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);
  const id = parseInt(params?.id, 10);
  if (!id) return json({ ok: false, error: "id_required" }, 400, request, env);

  let body = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400, request, env); }

  const sets = [];
  const binds = [];
  if (typeof body.cover_letter === "string") { sets.push("cover_letter = ?"); binds.push(body.cover_letter); }
  if (typeof body.notes === "string") { sets.push("notes = ?"); binds.push(body.notes); }
  if (body.custom_answers && typeof body.custom_answers === "object") { sets.push("custom_answers = ?"); binds.push(JSON.stringify(body.custom_answers)); }
  if (typeof body.status === "string" && ["draft","submitting","submitted","failed","withdrawn"].includes(body.status)) { sets.push("status = ?"); binds.push(body.status); }
  if (typeof body.submission_url === "string") { sets.push("submission_url = ?"); binds.push(body.submission_url); }
  if (typeof body.submission_method === "string") { sets.push("submission_method = ?"); binds.push(body.submission_method); }
  if (sets.length === 0) return json({ ok: false, error: "nothing_to_update" }, 400, request, env);
  sets.push("updated_at = datetime('now')");
  binds.push(id);
  await env.JOBS_DB.prepare(`UPDATE application SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  await env.JOBS_DB.prepare("INSERT INTO application_event (application_id, kind, detail) VALUES (?, ?, ?)")
    .bind(id, "updated", JSON.stringify({ fields: Object.keys(body) })).run().catch(() => null);
  return json({ ok: true }, 200, request, env);
}

export async function onRequestDelete({ request, env, params }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);
  const id = parseInt(params?.id, 10);
  if (!id) return json({ ok: false, error: "id_required" }, 400, request, env);
  await env.JOBS_DB.prepare("UPDATE application SET status = 'withdrawn', updated_at = datetime('now') WHERE id = ?").bind(id).run();
  await env.JOBS_DB.prepare("INSERT INTO application_event (application_id, kind, detail) VALUES (?, 'withdrawn', NULL)")
    .bind(id).run().catch(() => null);
  return json({ ok: true }, 200, request, env);
}

function safeJson(s, fb) { try { return JSON.parse(s); } catch { return fb; } }
