// _shared/db.js
//
// D1 helpers + idempotent migration runner. The app's migration files
// live in /migrations/*.sql; on the first call to ensureSchema, each
// file is run inside a try-catch (CREATE IF NOT EXISTS) and its name
// is recorded in `__migrations` so we don't re-apply.

import { MIGRATION_0001 } from "./migrations.js";

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS __migrations (
  name        TEXT PRIMARY KEY,
  applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const MIGRATIONS = {
  "0001_init.sql": MIGRATION_0001,
};

export async function ensureSchema(env) {
  const db = env.JOBS_DB;
  if (!db) throw new Error("JOBS_DB binding missing");
  await db.prepare(MIGRATIONS_TABLE).run();

  for (const [name, sql] of Object.entries(MIGRATIONS)) {
    const already = await db.prepare("SELECT 1 AS x FROM __migrations WHERE name = ?").bind(name).first().catch(() => null);
    if (already) continue;
    const stmts = sql.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean);
    for (const s of stmts) {
      try { await db.prepare(s).run(); }
      catch { /* ignore — IF NOT EXISTS makes re-runs safe */ }
    }
    await db.prepare("INSERT INTO __migrations (name) VALUES (?)").bind(name).run().catch(() => {});
  }
}

export async function recordScrapeRun(env, stats) {
  const r = await env.JOBS_DB.prepare(`
    INSERT INTO scrape_run
      (companies_attempted, companies_succeeded, companies_failed, jobs_found, new_jobs, removed_jobs, trigger, duration_ms, notes, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(
    stats.attempted || 0,
    stats.succeeded || 0,
    stats.failed || 0,
    stats.jobs_found || 0,
    stats.new_jobs || 0,
    stats.removed_jobs || 0,
    stats.trigger || "manual",
    stats.duration_ms || 0,
    stats.notes || null
  ).run().catch(() => null);
  return r?.meta?.last_row_id || null;
}