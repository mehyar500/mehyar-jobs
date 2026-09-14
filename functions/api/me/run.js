// POST /api/me/run — score the job board against the user's resume.
//
// The paid-with-newsletter action: requires an account (requireUser) and an
// uploaded resume. Scores up to RUN_JOB_CAP recent active jobs with the same
// deterministic engine the owner uses, stores per-user scores, and returns
// the top matches.

import { ensureSchema } from "../../_shared/db.js";
import { json, onRequestOptions, requireUser, getUserFitProfile } from "../../_shared/userAuth.js";
import { scoreJob } from "../../_shared/fit.js";
import { sendEmail } from "../../_shared/email.js";

export { onRequestOptions as onRequest };

const RUN_JOB_CAP = 1500;   // jobs scored per run
const KEEP_MIN_SCORE = 35;  // below this we don't store (noise)
const RETURN_TOP = 50;

export async function onRequestPost({ request, env }) {
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);
  const auth = await requireUser(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  const userId = auth.user.id;
  const db = env.JOBS_DB;

  const profile = await getUserFitProfile(env, userId);
  if (!profile.resume_text || profile.resume_text.trim().length < 50) {
    return json({ ok: false, error: "resume_required", message: "Upload your resume first." }, 400, request, env);
  }

  const rows = await db.prepare(`
    SELECT j.id, j.title, j.description_text, j.location, j.remote_policy,
           j.salary_min, j.salary_max, j.posted_at, c.industry
    FROM job j JOIN company c ON c.id = j.company_id
    WHERE j.is_active = 1
    ORDER BY j.first_seen_at DESC
    LIMIT ?
  `).bind(RUN_JOB_CAP).all().catch(() => ({ results: [] }));
  const jobs = rows.results || [];

  const scored = [];
  for (const row of jobs) {
    const out = scoreJob(row, profile, row.industry);
    if (out.score >= KEEP_MIN_SCORE) {
      // Store the human-readable explanation lines so the UI can show
      // "Why this fit?" without recomputing.
      const display = (out.explain && out.explain.length ? out.explain : out.reasons) || [];
      scored.push({ job_id: row.id, score: out.score, reasons: JSON.stringify(display), hard_no: out.hard_no ? 1 : 0, hard_no_reason: out.hard_no_reason || null });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  // Replace the user's previous run.
  await db.prepare("DELETE FROM user_job_fit WHERE user_id = ?").bind(userId).run().catch(() => null);
  for (let i = 0; i < scored.length; i += 40) {
    const batch = scored.slice(i, i + 40).map((s) =>
      db.prepare(`
        INSERT INTO user_job_fit (user_id, job_id, score, reasons, hard_no, hard_no_reason)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(userId, s.job_id, s.score, s.reasons, s.hard_no, s.hard_no_reason)
    );
    if (batch.length) await db.batch(batch).catch(() => null);
  }

  const topIds = scored.slice(0, RETURN_TOP).map((s) => s.job_id);
  let top = [];
  if (topIds.length) {
    const placeholders = topIds.map(() => "?").join(",");
    const detail = await db.prepare(`
      SELECT j.id, j.title, j.url, j.location, j.remote_policy, j.employment_type,
             j.salary_min, j.salary_max, j.salary_currency, j.posted_at,
             c.name AS company_name, c.industry AS company_industry,
             f.score, f.reasons, f.hard_no, f.hard_no_reason
      FROM user_job_fit f
      JOIN job j ON j.id = f.job_id
      JOIN company c ON c.id = j.company_id
      WHERE f.user_id = ? AND f.job_id IN (${placeholders})
      ORDER BY f.score DESC
    `).bind(userId, ...topIds).all().catch(() => ({ results: [] }));
    top = (detail.results || []).map((r) => ({ ...r, reasons: JSON.parse(r.reasons || "[]") }));
  }

  const strong = scored.filter((s) => s.score >= 70 && !s.hard_no).length;

  // Results email (best-effort).
  const appUrl = env?.JOBS_APP_URL || env?.APP_HOST || "https://jobs.mehyar.us";
  const name = auth.user.display_name || "there";
  const lines = top.slice(0, 10).map((t, i) => `${i + 1}. ${t.title} — ${t.company_name} (${t.score}/100)\n   ${t.url}`).join("\n\n");
  sendEmail(env, {
    to: auth.user.email,
    subject: `mehyar.jobs: your resume run found ${scored.length} matches (${strong} strong)`,
    text: `Hi ${name},\n\nYour resume run is done:\n- ${scored.length} matching jobs\n- ${strong} strong matches (70+)\n\nTop matches:\n\n${lines}\n\nSee them all: ${appUrl}/matches\n\nYou'll keep getting a digest email when strong new matches appear.\n\n— mehyar.jobs`,
    html: `<p>Hi ${name},</p><p>Your resume run is done: <strong>${scored.length}</strong> matching jobs, <strong>${strong}</strong> strong matches (70+).</p><p><a href="${appUrl}/matches">See all your matches</a></p><p>You'll keep getting a digest email when strong new matches appear.</p><p>— mehyar.jobs</p>`,
  }).catch(() => null);

  return json({
    ok: true,
    scored_jobs: jobs.length,
    matches: scored.length,
    strong_matches: strong,
    top,
  }, 200, request, env);
}
