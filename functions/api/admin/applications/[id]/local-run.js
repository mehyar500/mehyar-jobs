import { requireAdmin, json, onRequestOptions } from "../../../../_shared/adminAuth.js";
import { ensureSchema } from "../../../../_shared/db.js";

export { onRequestOptions as onRequest };

const OUTCOMES = new Set(["review_ready", "needs_user_action", "submitted", "failed"]);
const MAX_TEXT = 24_000;
const MAX_SCREENSHOT = 2_000_000;

export async function onRequestPost({ request, env, params }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);
  const id = Number.parseInt(params?.id, 10);
  if (!id) return json({ ok: false, error: "id_required" }, 400, request, env);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400, request, env); }
  const issue = validateLocalRun(body);
  if (issue) return json({ ok: false, error: issue }, 400, request, env);

  const app = await env.JOBS_DB.prepare("SELECT id, job_id, status FROM application WHERE id = ?").bind(id).first();
  if (!app) return json({ ok: false, error: "not_found" }, 404, request, env);
  if (app.status === "submitted" && body.outcome !== "submitted") return json({ ok: false, error: "already_submitted" }, 409, request, env);

  const now = "datetime('now')";
  const fields = JSON.stringify(body.fields || []);
  const answers = JSON.stringify(body.answers || []);
  const isSubmitted = body.outcome === "submitted";
  const status = isSubmitted ? "submitted" : "draft";
  await env.JOBS_DB.prepare(`UPDATE application SET
      status = ?, cover_letter = COALESCE(?, cover_letter), cover_letter_sent = CASE WHEN ? THEN ? ELSE cover_letter_sent END,
      custom_answers = COALESCE(?, custom_answers), custom_answers_sent = CASE WHEN ? THEN ? ELSE custom_answers_sent END,
      fields_filled_json = ?, application_method = 'local_browser', external_url = COALESCE(?, external_url),
      submitted_at = CASE WHEN ? THEN ${now} ELSE submitted_at END, updated_at = ${now}
    WHERE id = ?`)
    .bind(status, body.cover_letter || null, isSubmitted ? 1 : 0, body.cover_letter || null,
      answers, isSubmitted ? 1 : 0, answers, fields, body.final_url || null, isSubmitted ? 1 : 0, id).run();

  const run = await env.JOBS_DB.prepare(`INSERT INTO auto_submit_run
    (application_id, status, started_at, finished_at, final_url, confirmation_detected, log, form_filled, screenshot_base64, error)
    VALUES (?, ?, ${now}, ${now}, ?, ?, ?, ?, ?, ?)`)
    .bind(id, body.outcome, body.final_url || null, body.confirmation_detected ? 1 : 0,
      JSON.stringify(body.log || []), fields, body.screenshot_base64 || null, body.error || null).run();

  const queueStatus = isSubmitted ? "completed" : body.outcome;
  await env.JOBS_DB.prepare(`UPDATE application_queue SET application_id = ?, status = ?, finished_at = ${now},
      last_error = ?, attempts = attempts + 1 WHERE job_id = ?`)
    .bind(id, queueStatus, body.error || null, app.job_id).run().catch(() => null);
  if (isSubmitted) {
    const day = new Date().toISOString().slice(0, 10);
    await env.JOBS_DB.prepare(`INSERT INTO daily_counter (day, submitted, succeeded) VALUES (?, 1, 1)
      ON CONFLICT(day) DO UPDATE SET submitted = submitted + 1, succeeded = succeeded + 1`).bind(day).run().catch(() => null);
  }
  await env.JOBS_DB.prepare("INSERT INTO application_event (application_id, kind, detail) VALUES (?, ?, ?)")
    .bind(id, "local_browser_" + body.outcome, JSON.stringify({ run_id: run?.meta?.last_row_id || null, fields: (body.fields || []).length, confirmation_detected: !!body.confirmation_detected })).run();
  return json({ ok: true, run_id: run?.meta?.last_row_id || null }, 200, request, env);
}

export function validateLocalRun(body) {
  if (!body || typeof body !== "object" || !OUTCOMES.has(body.outcome)) return "invalid_outcome";
  for (const key of ["cover_letter", "final_url", "error"]) if (body[key] != null && (typeof body[key] !== "string" || body[key].length > MAX_TEXT)) return "invalid_" + key;
  if (!Array.isArray(body.fields) || body.fields.length > 100 || !Array.isArray(body.answers) || body.answers.length > 50) return "invalid_field_count";
  for (const field of [...body.fields, ...body.answers]) if (!field || typeof field !== "object" || typeof field.label !== "string" && typeof field.question !== "string") return "invalid_field";
  if (body.screenshot_base64 && (typeof body.screenshot_base64 !== "string" || body.screenshot_base64.length > MAX_SCREENSHOT)) return "invalid_screenshot";
  return null;
}
