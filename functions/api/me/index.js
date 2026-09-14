// GET /api/me — current user summary.

import { ensureSchema } from "../../_shared/db.js";
import { json, onRequestOptions, requireUser } from "../../_shared/userAuth.js";

export { onRequestOptions as onRequest };

export async function onRequestGet({ request, env }) {
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);
  const auth = await requireUser(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  const u = auth.user;

  const resume = await env.JOBS_DB.prepare(
    "SELECT id, filename, mime, created_at, llm_review_json FROM user_resume WHERE user_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 1"
  ).bind(u.id).first().catch(() => null);
  let llmReview = null;
  try { llmReview = resume?.llm_review_json ? JSON.parse(resume.llm_review_json) : null; } catch { llmReview = null; }
  const matchCount = await env.JOBS_DB.prepare(
    "SELECT COUNT(*) AS n FROM user_job_fit WHERE user_id = ? AND score >= 60 AND hard_no = 0"
  ).bind(u.id).first().catch(() => ({ n: 0 }));
  const lastRun = await env.JOBS_DB.prepare(
    "SELECT MAX(scored_at) AS at FROM user_job_fit WHERE user_id = ?"
  ).bind(u.id).first().catch(() => ({ at: null }));

  return json({
    ok: true,
    user: {
      id: u.id,
      email: u.email,
      display_name: u.display_name,
      is_admin: u.is_admin === 1,
      newsletter_opt_in: u.newsletter_opt_in === 1,
      has_resume: !!resume,
      resume_filename: resume?.filename || null,
      resume_created_at: resume?.created_at || null,
      llm_review: llmReview,
      strong_matches: matchCount?.n || 0,
      last_run_at: lastRun?.at || null,
    },
  }, 200, request, env);
}
