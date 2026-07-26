// /api/email/inbound
//
//   POST → webhook endpoint that CF Email Routing calls whenever a
//          new email arrives at info@mehyar.us (or app-{id}@jobs.mehyar.us).
//
//   The endpoint parses the email, finds the application whose
//   job_url or tracking_email matches the From: address, and
//   marks the application as company_confirmed (auto_email source).
//
//   For now, this endpoint is the receiver; wiring it to CF Email
//   Routing requires a one-time setup of an Email Worker that
//   forwards to this URL. The setup script is in scripts/setup-email-routing.sh.
//
// Body shape from CF Email Worker:
//   { from, to, subject, text, html, headers, ... }

import { json, corsHeaders, onRequestOptions } from "../../_shared/adminAuth.js";
import { ensureSchema } from "../../_shared/db.js";

export { onRequestOptions as onRequest };

const SAFE_FAILURE = "Email received but could not be processed.";

export async function onRequestPost({ request, env }) {
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);

  let body = {};
  try { body = await request.json(); } catch {
    return json({ ok: false, error: "bad_json" }, 400, request, env);
  }

  const from = (body.from || "").toLowerCase();
  const to   = (body.to   || "").toLowerCase();
  const subject = String(body.subject || "").slice(0, 300);
  const text = String(body.text || body.html || "").slice(0, 20000);

  // 1. Match by tracking_email = to-address (e.g. app-42@jobs.mehyar.us)
  let app = null;
  const toMatch = to.match(/app-(\d+)@/i);
  if (toMatch) {
    app = await env.JOBS_DB.prepare("SELECT * FROM application WHERE id = ?").bind(parseInt(toMatch[1], 10)).first();
  }

  // 2. Fallback: match by from-address against company careers URL
  if (!app && from) {
    const senderDomain = from.split("@")[1] || "";
    if (senderDomain) {
      app = (await env.JOBS_DB.prepare(`
        SELECT a.* FROM application a
        JOIN job j     ON j.id = a.job_id
        JOIN company c ON c.id = j.company_id
        WHERE a.status = 'submitted'
          AND a.company_confirmed_at IS NULL
          AND (
            c.careers_url LIKE ?
            OR j.url LIKE ?
          )
        ORDER BY a.submitted_at DESC
        LIMIT 1
      `).bind(`%${senderDomain}%`, `%${senderDomain}%`).all().catch(() => ({ results: [] }))).results?.[0];
    }
  }

  if (!app) {
    // No matching application. Just log the email and return 200 so CF
    // doesn't keep retrying.
    await env.JOBS_DB.prepare(`
      INSERT INTO email_inbound (from_addr, to_addr, subject, body_excerpt, matched_application_id, matched_at)
      VALUES (?, ?, ?, ?, NULL, datetime('now'))
    `).bind(from, to, subject, text.slice(0, 200)).run().catch(() => null);
    return json({ ok: true, matched: false, message: "no_matching_application" }, 200, request, env);
  }

  // 3. Mark the application as company_confirmed
  const now = new Date().toISOString();
  await env.JOBS_DB.prepare(`
    UPDATE application
    SET company_confirmed_at = ?,
        company_confirmed_source = 'auto_email',
        company_email_subject = ?,
        updated_at = ?
    WHERE id = ?
  `).bind(now, subject, now, app.id).run();
  await env.JOBS_DB.prepare(`
    INSERT INTO application_event (application_id, kind, detail) VALUES (?, 'company_confirmed', ?)
  `).bind(app.id, JSON.stringify({ source: "auto_email", from, subject, at: now })).run().catch(() => null);
  await env.JOBS_DB.prepare(`
    INSERT INTO email_inbound (from_addr, to_addr, subject, body_excerpt, matched_application_id, matched_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).bind(from, to, subject, text.slice(0, 200), app.id).run().catch(() => null);

  return json({ ok: true, matched: true, application_id: app.id, subject, from }, 200, request, env);
}
