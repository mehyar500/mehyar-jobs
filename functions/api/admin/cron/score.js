// POST /api/admin/cron/score { cursor, limit }
//
// Scores a bounded job batch. Callers continue with next_cursor until
// done=true, avoiding a multi-thousand-write Pages request.

import { requireAdmin, json, onRequestOptions } from "../../../_shared/adminAuth.js";
import { ensureSchema } from "../../../_shared/db.js";
import { scoreJob, loadProfile } from "../../../_shared/fit.js";

export { onRequestOptions as onRequest };

export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);

  await ensureSchema(env);
  const body = await request.json().catch(() => ({}));
  const cursor = Math.max(0, Number(body.cursor || 0));
  const limit = Math.max(50, Math.min(500, Number(body.limit || 300)));
  const db = env.JOBS_DB;
  const profile = await loadProfile(await db.prepare("SELECT * FROM profile WHERE id = 1").first());
  const rows = await db.prepare(`
    SELECT j.id, j.title, j.description_text, j.location, j.remote_policy, j.salary_min, j.salary_max, j.posted_at,
           c.industry
    FROM job j JOIN company c ON c.id = j.company_id
    WHERE j.is_active = 1 AND j.id > ?
    ORDER BY j.id ASC
    LIMIT ?
  `).bind(cursor, limit).all();

  let scored = 0;
  let hardNo = 0;
  let top = 0;
  const statements = [];
  for (const row of rows.results || []) {
    const out = scoreJob(row, profile, row.industry);
    statements.push(db.prepare(`
      INSERT INTO job_fit (job_id, score, reasons, hard_no, hard_no_reason, profile_version)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(job_id) DO UPDATE SET
        score = excluded.score,
        reasons = excluded.reasons,
        hard_no = excluded.hard_no,
        hard_no_reason = excluded.hard_no_reason,
        scored_at = datetime('now'),
        profile_version = 1
    `).bind(row.id, out.score, JSON.stringify(out.reasons), out.hard_no ? 1 : 0, out.hard_no_reason));
    scored += 1;
    if (out.hard_no) hardNo += 1;
    if (out.score >= 70 && !out.hard_no) top += 1;
  }
  for (let index = 0; index < statements.length; index += 50) await db.batch(statements.slice(index, index + 50));

  const last = (rows.results || []).at(-1)?.id || cursor;
  const remaining = await db.prepare("SELECT id FROM job WHERE is_active = 1 AND id > ? ORDER BY id ASC LIMIT 1").bind(last).first();
  const done = !remaining;
  const alertsCreated = done ? await createTopAlerts(db) : 0;
  return json({
    ok: true,
    scored,
    hard_no: hardNo,
    top,
    cursor: last,
    next_cursor: done ? null : last,
    done,
    alerts_created: alertsCreated,
    profile_version: 1,
  }, 200, request, env);
}

export async function onRequestGet(context) {
  return onRequestPost(context);
}

async function createTopAlerts(db) {
  const jobs = await db.prepare(`
    SELECT j.id, j.title, c.name AS company, jf.score
    FROM job j
    JOIN company c ON c.id = j.company_id
    JOIN job_fit jf ON jf.job_id = j.id
    WHERE jf.score >= 70 AND jf.hard_no = 0
      AND NOT EXISTS (SELECT 1 FROM alert a WHERE a.kind = 'high_fit' AND a.job_id = j.id)
    ORDER BY jf.score DESC LIMIT 25
  `).all();
  const statements = (jobs.results || []).map((job) => db.prepare("INSERT INTO alert (kind, job_id, message) VALUES ('high_fit', ?, ?)")
    .bind(job.id, `${job.company} — ${job.title} (fit ${job.score})`));
  if (statements.length) await db.batch(statements);
  return statements.length;
}
