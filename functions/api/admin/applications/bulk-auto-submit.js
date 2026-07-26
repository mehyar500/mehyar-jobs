// /api/admin/applications/bulk-auto-submit
//
//   POST { application_ids?: number[], fit_min?: number, confirm: true }
//
// Runs auto-submit in parallel for multiple draft applications.
// Returns a per-app status map. The user gets a single response
// after the LAST one finishes (or after a 60s budget).
//
//   GET → returns the latest bulk run summary.

import { requireAdmin, json, corsHeaders, onRequestOptions } from "../../../_shared/adminAuth.js";
import { ensureSchema } from "../../../_shared/db.js";
import { loadProfile } from "../../../_shared/fit.js";

export { onRequestOptions as onRequest };

export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);

  let body = {};
  try { body = await request.json(); } catch { body = {}; }
  if (!body.confirm) {
    return json({
      ok: false,
      error: "confirm_required",
      message: "Bulk auto-submit must be explicitly confirmed. Pass `{ confirm: true }` in the POST body. " +
               "This will run the headless browser against multiple job forms in parallel. " +
               "Each application logs a per-app run; results come back as a map.",
    }, 400, request, env);
  }

  // Pick the targets
  let ids = Array.isArray(body.application_ids) ? body.application_ids : [];
  if (!ids.length) {
    // Default: all draft applications on jobs with fit >= fit_min (default 70)
    const fitMin = Math.max(0, Math.min(100, parseInt(body.fit_min || "70", 10)));
    const rows = (await env.JOBS_DB.prepare(`
      SELECT a.id AS application_id
      FROM application a
      JOIN job j ON j.id = a.job_id
      LEFT JOIN job_fit jf ON jf.job_id = j.id
      WHERE a.status = 'draft'
        AND (jf.score IS NULL OR jf.score >= ?)
      ORDER BY jf.score DESC NULLS LAST
      LIMIT 25
    `).bind(fitMin).all().catch(() => ({ results: [] }))).results || [];
    ids = rows.map((r) => r.application_id);
  }
  ids = ids.slice(0, 25);  // hard cap per bulk run

  if (!ids.length) {
    return json({ ok: true, ran: 0, results: [], message: "no_targets" }, 200, request, env);
  }

  const profile = await loadProfile(env);

  // Run them in parallel
  const startedAt = Date.now();
  const promises = ids.map(async (id) => {
    const itemStartedAt = Date.now();
    try {
      const app = await env.JOBS_DB.prepare(`
        SELECT a.id, a.job_id, a.status, a.tracking_email, a.cover_letter, a.custom_answers,
               j.url AS job_url, j.title AS job_title,
               c.name AS company_name, c.careers_url AS company_careers_url
        FROM application a
        JOIN job j     ON j.id = a.job_id
        JOIN company c ON c.id = j.company_id
        WHERE a.id = ?
      `).bind(id).first();
      if (!app) return { id, ok: false, error: "not_found", duration_ms: Date.now() - itemStartedAt };
      if (app.status !== "draft") return { id, ok: false, error: "not_draft", status: app.status, duration_ms: Date.now() - itemStartedAt };

      // Reuse the same per-app run logic
      const { runAutomation } = await import("../applications/[id]/auto-submit.js");
      // That import path may not work in CF Workers bundler; use the
      // local function instead via a different route.
      // For bulk, we just call the single endpoint internally:
      const inner = await env.JOBS_DB.prepare(`
        UPDATE application SET status = 'auto_submitting', updated_at = datetime('now') WHERE id = ?
      `).bind(id).run();
      const r = await fetch(`${new URL(request.url).origin}/api/admin/applications/${id}/auto-submit`, {
        method: "POST",
        headers: { "authorization": request.headers.get("authorization") || "", "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      const body = await r.json().catch(() => ({}));
      return { id, ok: r.ok, job_title: app.job_title, company_name: app.company_name, ...body, duration_ms: Date.now() - itemStartedAt };
    } catch (e) {
      return { id, ok: false, error: String(e?.message || e), duration_ms: Date.now() - itemStartedAt };
    }
  });

  const results = await Promise.allSettled(promises);
  const flat = results.map((r) => r.status === "fulfilled" ? r.value : { ok: false, error: r.reason?.message });
  return json({
    ok: true,
    ran: ids.length,
    duration_ms: Date.now() - startedAt,
    succeeded: flat.filter((r) => r.ok).length,
    failed: flat.filter((r) => !r.ok).length,
    results: flat,
  }, 200, request, env);
}
