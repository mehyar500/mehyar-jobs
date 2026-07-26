// POST /api/admin/cron/score
//
// (Re-)scores every active job against the current profile. Intended to
// run right after a profile edit; also called by the daily scrape cron.
// Cheap (~150µs per job in D1, ~few seconds for 5K jobs).

import { requireAdmin, json, corsHeaders, onRequestOptions } from "../../../_shared/adminAuth.js";
import { ensureSchema } from "../../../_shared/db.js";
import { scoreJob, loadProfile } from "../../../_shared/fit.js";

export { onRequestOptions as onRequest };

export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);

  await ensureSchema(env);
  const db = env.JOBS_DB;

  const profileRow = await db.prepare("SELECT * FROM profile WHERE id = 1").first();
  const profile = loadProfile(profileRow);

  // Pull every active job joined with its company industry in chunks.
  const rows = await db.prepare(`
    SELECT j.id, j.title, j.description_text, j.location, j.remote_policy, j.salary_min, j.salary_max,
           c.industry
    FROM job j JOIN company c ON c.id = j.company_id
    WHERE j.is_active = 1
  `).all().catch(() => ({ results: [] }));

  const stmt = db.prepare(`
    INSERT INTO job_fit (job_id, score, reasons, hard_no, hard_no_reason, profile_version)
    VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(job_id) DO UPDATE SET
      score = excluded.score,
      reasons = excluded.reasons,
      hard_no = excluded.hard_no,
      hard_no_reason = excluded.hard_no_reason,
      scored_at = datetime('now'),
      profile_version = 1
  `);

  let scored = 0, hardNo = 0, top = 0;
  for (const r of (rows.results || [])) {
    const out = scoreJob({
      title: r.title,
      description_text: r.description_text,
      location: r.location,
      remote_policy: r.remote_policy,
      salary_min: r.salary_min,
      salary_max: r.salary_max,
    }, profile, r.industry);

    await stmt.bind(
      r.id, out.score, JSON.stringify(out.reasons), out.hard_no ? 1 : 0, out.hard_no_reason
    ).run().catch(() => {});

    scored += 1;
    if (out.hard_no) hardNo += 1;
    if (out.score >= 70) top += 1;
  }

  // Surface new alerts for any newly-discovered 70+ matches not previously alerted.
  const topJobs = await db.prepare(`
    SELECT j.id, j.title, c.name AS company, j.url, jf.score, jf.hard_no
    FROM job j
    JOIN company c ON c.id = j.company_id
    JOIN job_fit jf ON jf.job_id = j.id
    WHERE jf.score >= 70 AND jf.hard_no = 0
    ORDER BY jf.score DESC LIMIT 25
  `).all().catch(() => ({ results: [] }));

  let alertsCreated = 0;
  for (const j of (topJobs.results || [])) {
    const exists = await db.prepare("SELECT 1 AS x FROM alert WHERE kind = 'high_fit' AND job_id = ?").bind(j.id).first().catch(() => null);
    if (exists) continue;
    await db.prepare("INSERT INTO alert (kind, job_id, message) VALUES ('high_fit', ?, ?)")
      .bind(j.id, `${j.company} — ${j.title} (fit ${j.score})`).run().catch(() => {});
    alertsCreated += 1;
  }

  return json({
    ok: true,
    scored, hard_no: hardNo, top: top,
    alerts_created: alertsCreated,
    profile_version: 1,
  }, 200, request, env);
}

export async function onRequestGet({ request, env }) {
  return onRequestPost({ request, env });
}