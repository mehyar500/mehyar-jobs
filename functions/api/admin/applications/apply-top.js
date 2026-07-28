// /api/admin/applications/apply-top
//
//   POST { fit_min?: number, limit?: number, confirm: true }
//
// "FULLY AUTOMATED APPLY-TO-TOP-N"
//   - pick the top N unscored jobs at fit_min+
//   - create a draft application for each (if no app exists yet)
//   - run auto-submit on each in parallel
//   - return a per-job status map
//
// Designed for the user's "Fully automated job applying" use case:
// tap one button → top 20 best-match jobs get drafted + auto-submitted
// (via the assisted-fallback path, since BR isn't available on this CF account).

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
      message: "Confirm by passing `{ confirm: true }`. This will create drafts and run auto-submit (assisted) on the top N jobs by fit score.",
    }, 400, request, env);
  }

  const fitMin  = Math.max(0, Math.min(100, parseInt(body.fit_min || "55", 10)));
  const limit   = Math.max(1, Math.min(50, parseInt(body.limit || "10", 10)));
  const skipIfApplied = body.skip_if_applied !== false; // default true

  // 1. Pick top-N jobs at fit_min+ that DO NOT YET have a draft application
  //    (or skip_if_applied=false lets us re-run on existing drafts)
  const candidates = (await env.JOBS_DB.prepare(`
    SELECT j.id AS job_id, j.title, j.url, j.score
    FROM (
      SELECT j.id, j.title, j.url,
             COALESCE(jf.score, 0) AS score,
             c.name AS company_name
      FROM job j
      JOIN company c ON c.id = j.company_id
      LEFT JOIN job_fit jf ON jf.job_id = j.id
      WHERE j.is_active = 1
        AND (jf.hard_no IS NULL OR jf.hard_no = 0)
        AND COALESCE(jf.score, 0) >= ?
        AND j.url IS NOT NULL AND j.url != ''
      ORDER BY COALESCE(jf.score, 0) DESC, j.first_seen_at DESC
      LIMIT ?
    ) j
    ${skipIfApplied ? `
    LEFT JOIN application a ON a.job_id = j.id
    WHERE a.id IS NULL
    ` : ``}
    LIMIT ?
  `).bind(fitMin, limit * 3, limit).all().catch((e) => ({ results: [], error: e.message }))).results || [];

  if (!candidates.length) {
    return json({
      ok: true,
      ran: 0,
      candidates_considered: 0,
      results: [],
      message: `no_qualifying_jobs: found 0 jobs with fit ≥ ${fitMin} that haven't been drafted. Lower fit_min or check that companies have public application URLs.`,
    }, 200, request, env);
  }

  // 2. For each candidate: create a draft application (if missing) and run auto-submit
  const profile = await loadProfile(env);
  const results = await Promise.allSettled(candidates.map(async (job) => {
    // Create draft application if missing (or update existing draft)
    const existing = await env.JOBS_DB.prepare(
      `SELECT id, status FROM application WHERE job_id = ? ORDER BY id DESC LIMIT 1`
    ).bind(job.job_id).first();

    let appId = existing?.id;
    if (!appId) {
      const inserted = await env.JOBS_DB.prepare(
        `INSERT INTO application (job_id, status, submission_method, created_at, updated_at)
         VALUES (?, 'draft', 'assisted', datetime('now'), datetime('now'))
         RETURNING id`
      ).bind(job.job_id).first();
      appId = inserted?.id;
      await env.JOBS_DB.prepare(
        `INSERT INTO application_event (application_id, kind, detail, created_at)
         VALUES (?, 'created', ?, datetime('now'))`
      ).bind(appId, JSON.stringify({source:'apply-top', fit: job.score, job_title: job.title})).run();
    } else if (existing.status === 'submitted' || existing.status === 'confirmed') {
      // Skip if already submitted and skip_if_applied=true
      return { job_id: job.job_id, app_id: appId, ok: false, status: existing.status, skipped: true, reason: "already_submitted" };
    } else {
      // Update existing draft to latest
      await env.JOBS_DB.prepare(
        `UPDATE application SET updated_at = datetime('now') WHERE id = ?`
      ).bind(appId).run();
    }

    // 3. Run auto-submit (assisted path will kick in since BR unavailable)
    //    Forward the same Authorization header so the inner request authenticates.
    const innerAuth = request.headers.get("authorization") || "";
    const subUrl = `https://jobs.mehyar.us/api/admin/applications/${appId}/auto-submit`;
    try {
      const r = await fetch(subUrl, {
        method: "POST",
        headers: {
          authorization: innerAuth,
          "content-type": "application/json",
          "user-agent": "mehyar-bot/1.0 (apply-top-orchestrator)",
        },
        body: JSON.stringify({ confirm: true, trigger: "apply-top" }),
      });
      const d = await r.json().catch(() => ({}));
      await env.JOBS_DB.prepare(
        `INSERT INTO application_event (application_id, kind, detail, created_at)
         VALUES (?, 'auto_apply_top', ?, datetime('now'))`
      ).bind(appId, JSON.stringify({app_id: appId, job_id: job.job_id, ok: !!d.ok, mode: d.mode || "unknown", fields_detected: d.fields_detected || 0})).run();
      return {
        job_id: job.job_id,
        app_id: appId,
        title: job.title,
        url: job.url,
        fit: job.score,
        ok: !!d.ok,
        mode: d.mode,
        fields_detected: d.fields_detected,
        fields_filled: d.fields_filled,
        llm_answers: d.llm_answers?.length || 0,
        job_url: d.job_url || job.url,
        error: d.error,
      };
    } catch (e) {
      await env.JOBS_DB.prepare(
        `UPDATE application SET status = 'failed', updated_at = datetime('now') WHERE id = ?`
      ).bind(appId).run();
      return {
        job_id: job.job_id,
        app_id: appId,
        title: job.title,
        url: job.url,
        fit: job.score,
        ok: false,
        error: e?.message || String(e),
      };
    }
  }));

  const ran = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;
  const items = results.map((r) => r.status === "fulfilled" ? r.value : { ok: false, error: r.reason?.message });

  return json({
    ok: true,
    ran,
    failed,
    candidates_considered: candidates.length,
    fit_min: fitMin,
    results: items,
    message: `Applied to ${items.filter((i) => i.ok && !i.skipped).length}/${candidates.length} jobs (${failed} failed)`,
  }, 200, request, env);
}

export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  // Return a small summary view — last 24h apply-top runs
  try {
    const rows = (await env.JOBS_DB.prepare(`
      SELECT ae.created_at, ae.payload
      FROM application_event ae
      WHERE ae.kind = 'auto_apply_top'
        AND datetime(ae.created_at) > datetime('now', '-24 hours')
      ORDER BY ae.id DESC
      LIMIT 50
    `).all()).results || [];
    return json({ ok: true, runs: rows.length, last_run: rows[0] || null, history: rows }, 200, request, env);
  } catch (e) {
    return json({ ok: false, error: e?.message }, 500, request, env);
  }
}
