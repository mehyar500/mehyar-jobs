// POST /api/admin/jobs/{id}/mark
//   body: { action: "applied" | "skipped" | "applied_external", url?: string, note?: string }
//
// "applied"            → status=submitted, submission_method=manual,   submitted_at=now
// "applied_external"   → status=submitted, submission_method=external_link, submitted_at=now,
//                        submission_url = body.url || job.url
// "skipped"            → status=withdrawn (user is tracking that they looked and chose not to apply)
//
// Behaviour:
//   - upsert application row (UNIQUE on job_id). If a draft/failed/withdrawn row exists, update it.
//   - record an application_event row for audit.
//   - skip if status is already 'submitted' and no new info provided (idempotent).

import { requireAdmin, json, onRequestOptions } from "../../../../_shared/adminAuth.js";
import { ensureSchema } from "../../../../_shared/db.js";

export { onRequestOptions as onRequest };

export async function onRequestPost({ request, env, params }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);

  await ensureSchema(env);
  const db = env.JOBS_DB;

  const jobId = parseInt(params?.id, 10);
  if (!Number.isFinite(jobId)) return json({ ok: false, error: "bad_job_id" }, 400, request, env);

  let body = {};
  try { body = await request.json(); } catch {}
  const action = String((body && body.action) || "").toLowerCase();
  if (!["applied", "applied_external", "skipped"].includes(action)) {
    return json({ ok: false, error: "bad_action", allowed: ["applied", "applied_external", "skipped"] }, 400, request, env);
  }

  // Verify the job exists + grab its URL (for external_link default)
  const job = await db.prepare(`SELECT id, url, title FROM job WHERE id = ?`).bind(jobId).first().catch(() => null);
  if (!job) return json({ ok: false, error: "job_not_found" }, 404, request, env);

  const now = new Date().toISOString();
  let status, method, submissionUrl;
  let eventKind, eventDetail;

  if (action === "applied") {
    status = "submitted"; method = "manual"; submissionUrl = null;
    eventKind = "submitted_manual"; eventDetail = body?.note ? `note: ${String(body.note).slice(0, 200)}` : "marked applied manually";
  } else if (action === "applied_external") {
    status = "submitted"; method = "external_link";
    submissionUrl = String(body?.url || job.url || "").slice(0, 1000);
    eventKind = "submitted_external_link"; eventDetail = `via ${submissionUrl}`;
  } else { // skipped
    status = "withdrawn"; method = "manual"; submissionUrl = null;
    eventKind = "skipped"; eventDetail = body && body.note ? `note: ${String(body.note).slice(0, 200)}` : "skipped from Today";
  }

  // Look up existing application row (UNIQUE job_id)
  const existing = await db.prepare(`SELECT id, status FROM application WHERE job_id = ?`).bind(jobId).first().catch(() => null);

  let appId;
  if (existing?.id) {
    // Already submitted + same status → idempotent no-op
    if (existing.status === status && status === "submitted") {
      return json({ ok: true, idempotent: true, application_id: existing.id, status, submission_method: method }, 200, request, env);
    }
    await db.prepare(`
      UPDATE application
      SET status = ?, submission_method = ?, submission_url = COALESCE(?, submission_url),
          submitted_at = CASE WHEN ? = 'submitted' THEN COALESCE(submitted_at, ?) ELSE submitted_at END,
          notes = CASE WHEN ? != '' THEN ? ELSE notes END,
          updated_at = ?
      WHERE id = ?
    `).bind(
      status, method, submissionUrl,
      status, now,
      String(body?.note || ""), String(body?.note || "").slice(0, 500),
      now,
      existing.id
    ).run();
    appId = existing.id;
  } else {
    const r = await db.prepare(`
      INSERT INTO application (job_id, status, submission_method, submission_url, submitted_at, notes, updated_at)
      VALUES (?, ?, ?, ?, CASE WHEN ? = 'submitted' THEN ? ELSE NULL END, ?, ?)
    `).bind(
      jobId, status, method, submissionUrl,
      status, now,
      String(body?.note || "").slice(0, 500),
      now
    ).run();
    appId = Number(r?.meta?.last_row_id) || 0;
  }

  // Audit event
  await db.prepare(`
    INSERT INTO application_event (application_id, kind, detail, created_at)
    VALUES (?, ?, ?, ?)
  `).bind(appId, eventKind, eventDetail, now).run().catch(() => null);

  return json({
    ok: true,
    idempotent: false,
    application_id: appId,
    status,
    submission_method: method,
    submission_url: submissionUrl,
    job_id: jobId,
  }, 200, request, env);
}
