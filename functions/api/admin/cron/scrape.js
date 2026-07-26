// POST /api/admin/cron/scrape
//
// Fires the daily crawl across every active company. Returns a
// summary; long-running work is logged in `scrape_run` table.
// Auth: admin (shared JWT).

import { requireAdmin, json, corsHeaders, onRequestOptions } from "../../../_shared/adminAuth.js";
import { ensureSchema, recordScrapeRun } from "../../../_shared/db.js";
import { scrapeCompany } from "../../../_lib/scrapers/index.js";
import { SEED_COMPANIES } from "../../../_lib/data/seed_companies.js";

export { onRequestOptions as onRequest };

export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);

  await ensureSchema(env);
  const db = env.JOBS_DB;

  // Seed the directory on first run if it's empty
  const count = await db.prepare("SELECT COUNT(*) AS n FROM company").first().catch(() => ({ n: 0 }));
  if ((count?.n || 0) === 0) {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO company
        (name, slug, ticker, source, source_rank, industry, hq_country, hq_state, careers_url, careers_kind, careers_handle)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const c of SEED_COMPANIES) {
      await stmt.bind(c.name, c.slug, c.ticker || null, c.source, c.source_rank || null, c.industry || null, c.hq_country || null, c.hq_state || null, c.careers_url || null, c.careers_kind, c.careers_handle || null).run();
    }
  }

  // Pull active companies
  const rows = await db.prepare(`
    SELECT id, name, slug, careers_url, careers_kind, careers_handle, scrape_status, jobs_count
    FROM company
    ORDER BY jobs_count DESC, id ASC
    LIMIT 200
  `).all().catch(() => ({ results: [] }));

  const startedAt = Date.now();
  let succeeded = 0, failed = 0, jobsFound = 0, newJobs = 0, removedJobs = 0;

  // Track which companies we touched so we can mark the rest inactive later
  const seenIds = new Set();
  const companies = rows.results || [];
  const concurrency = 6;

  for (let i = 0; i < companies.length; i += concurrency) {
    const slice = companies.slice(i, i + concurrency);
    await Promise.all(slice.map(async (c) => {
      seenIds.add(c.id);
      const r = await scrapeCompany(c, { env }).catch((e) => ({ ok: false, error: e?.message }));
      if (!r.ok) {
        failed += 1;
        await db.prepare("UPDATE company SET scrape_status = 'broken', scrape_last_at = datetime('now'), scrape_error = ? WHERE id = ?")
          .bind(String(r.error || "unknown").slice(0, 200), c.id).run().catch(() => {});
        return;
      }
      succeeded += 1;
      const seenExtIds = new Set();
      for (const item of r.items || []) {
        if (!item.url || !item.title) continue;
        const before = await db.prepare("SELECT id FROM job WHERE company_id = ? AND external_id = ?").bind(c.id, item.external_id).first().catch(() => null);
        await db.prepare(`
          INSERT INTO job
            (company_id, external_id, source_kind, url, title, department, team, location, remote_policy, employment_type,
             posted_at, last_seen_at, description, description_text, raw_json, is_active)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, 1)
          ON CONFLICT(company_id, external_id) DO UPDATE SET
            title = excluded.title,
            department = excluded.department,
            team = excluded.team,
            location = excluded.location,
            remote_policy = excluded.remote_policy,
            employment_type = excluded.employment_type,
            posted_at = excluded.posted_at,
            last_seen_at = datetime('now'),
            description = excluded.description,
            description_text = excluded.description_text,
            raw_json = excluded.raw_json,
            is_active = 1
        `).bind(
          c.id, item.external_id, c.careers_kind, item.url, item.title,
          item.department, item.team, item.location, item.remote_policy, item.employment_type,
          item.posted_at, item.description, item.description_text, JSON.stringify(item.raw || {})
        ).run().catch(() => {});
        seenExtIds.add(item.external_id);
        jobsFound += 1;
        if (!before) newJobs += 1;
      }
      // Mark this company's previously-seen jobs that weren't in this scrape as inactive
      const removed = await db.prepare("UPDATE job SET is_active = 0 WHERE company_id = ? AND is_active = 1 AND external_id NOT IN (" + Array.from(seenExtIds).map(() => "?").join(",") + ")")
        .bind(c.id, ...seenExtIds).run().catch(() => ({ meta: { changes: 0 } }));
      removedJobs += removed?.meta?.changes || 0;

      await db.prepare("UPDATE company SET scrape_status = 'ok', scrape_last_at = datetime('now'), scrape_error = NULL, jobs_count = ? WHERE id = ?")
        .bind((r.items || []).length, c.id).run().catch(() => {});
    }));
  }

  const duration_ms = Date.now() - startedAt;
  await recordScrapeRun(env, {
    attempted: companies.length, succeeded, failed,
    jobs_found: jobsFound, new_jobs: newJobs, removed_jobs: removedJobs,
    trigger: "manual", duration_ms,
    notes: `seen=${seenIds.size}`,
  });

  return json({
    ok: true,
    attempted: companies.length, succeeded, failed,
    jobs_found: jobsFound, new_jobs: newJobs, removed_jobs: removedJobs,
    duration_ms,
  }, 200, request, env);
}

export async function onRequestGet({ request, env }) {
  // Convenience: allow GET to fire the scrape as well (same auth) so a
  // click in the dashboard can trigger via fetch without JS gymnastics.
  return onRequestPost({ request, env });
}