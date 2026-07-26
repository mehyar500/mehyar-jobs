// /api/admin/applications/{id}/confirm
//   POST → mark the company's "thank you" email as received.
//
// The third-party company sends the real confirmation email to the
// user's personal inbox. After seeing it, the user opens the
// application detail page and clicks "I got the company's email" —
// this endpoint records the confirmation so the app can show a
// timeline of "submitted → company confirmed → ... follow-ups".
//
// Optional fields in the body:
//   - subject: the email subject the user saw (e.g. "Thank you for
//     applying to OpenAI")
//   - source: "manual" (default) or "auto_email" (for future auto-detect)
//
// Auto-detect path: when a unique tracking email is wired up, the
// email handler at /api/email/inbound will POST here with source=
// "auto_email" and the parsed subject. Not yet wired in this round.

import { requireAdmin, json, corsHeaders, onRequestOptions } from "../../../../_shared/adminAuth.js";
import { ensureSchema } from "../../../../_shared/db.js";

export { onRequestOptions as onRequest };

export async function onRequestPost({ request, env, params }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);
  const id = parseInt(params?.id, 10);
  if (!id) return json({ ok: false, error: "id_required" }, 400, request, env);

  let body = {};
  try { body = await request.json(); } catch { body = {}; }

  const now = new Date().toISOString();
  const subject = typeof body.subject === "string" ? body.subject.slice(0, 200) : null;
  const source  = body.source === "auto_email" ? "auto_email" : "manual";

  // Verify application exists + is in submitted state
  const app = await env.JOBS_DB.prepare("SELECT id, status, submitted_at FROM application WHERE id = ?").bind(id).first();
  if (!app) return json({ ok: false, error: "not_found" }, 404, request, env);
  if (app.status !== "submitted" && app.status !== "failed") {
    return json({ ok: false, error: "not_submitted_yet", current_status: app.status }, 400, request, env);
  }

  await env.JOBS_DB.prepare(`
    UPDATE application
    SET company_confirmed_at = ?,
        company_confirmed_source = ?,
        company_email_subject = COALESCE(?, company_email_subject),
        updated_at = ?
    WHERE id = ?
  `).bind(now, source, subject, now, id).run();

  await env.JOBS_DB.prepare(`
    INSERT INTO application_event (application_id, kind, detail) VALUES (?, 'company_confirmed', ?)
  `).bind(id, JSON.stringify({ source, subject: subject || null, at: now })).run().catch(() => null);

  return json({ ok: true, id, company_confirmed_at: now, source }, 200, request, env);
}

// DELETE /api/admin/applications/{id}/confirm  → undo the confirmation
export async function onRequestDelete({ request, env, params }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);
  const id = parseInt(params?.id, 10);
  if (!id) return json({ ok: false, error: "id_required" }, 400, request, env);
  await env.JOBS_DB.prepare(`
    UPDATE application SET company_confirmed_at = NULL, company_confirmed_source = NULL, updated_at = datetime('now') WHERE id = ?
  `).bind(id).run();
  await env.JOBS_DB.prepare(`INSERT INTO application_event (application_id, kind, detail) VALUES (?, 'company_confirmed_undone', NULL)`)
    .bind(id).run().catch(() => null);
  return json({ ok: true }, 200, request, env);
}
