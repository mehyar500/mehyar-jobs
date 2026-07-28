// POST /api/admin/cron/cleanup-nav
//
// One-shot D1 cleanup: delete jobs whose title matches a category /
// nav / landing-page pattern. Used to scrub the noise that the
// first-generation HTML scraper pulled into the directory.
//
// Strategy: we re-run the same NAV_TITLE_BLOCKLIST that the scraper
// uses now, but against the persisted titles. Each match gets:
//   - application rows for that job: also deleted (cascade via FK)
//   - job_fit rows: deleted
//   - job row: deleted
//
// Returns: { ok, deleted_jobs, deleted_fits, scanned }
//
// Auth: admin (shared JWT).

import { requireAdmin, json, onRequestOptions } from "../../../_shared/adminAuth.js";
import { ensureSchema } from "../../../_shared/db.js";

export { onRequestOptions as onRequest };

const NAV_TITLE_RE_LIST = [
  /^all jobs$/i,
  /^jobs$/i,
  /^job openings$/i,
  /^job opportunities$/i,
  /^see all jobs$/i,
  /^see all opportunities$/i,
  /^view all jobs$/i,
  /^view all opportunities$/i,
  /^find (your|a) (next )?job/i,
  /^job search$/i,
  /^job matcher/i,
  /^jobs? by (category|business|department|team|location|function|area)/i,
  /^jobs in/i,
  /^careers?$/i,
  /^career (paths|areas?|opportunities|home)/i,
  /^featured (career|jobs?|roles?|opportunities|paths)/i,
  /^explore (jobs|careers|opportunities|roles)/i,
  /^browse (jobs|careers|opportunities|roles)/i,
  /^search (jobs|openings|roles)/i,
  /^open positions?$/i,
  /^open roles?$/i,
  /^available (positions?|roles?|jobs?|opportunities)/i,
  /^current (openings|opportunities|vacancies)/i,
  /^(internship|co-?op|graduate|university|student) (opportunities|programs?|jobs?)$/i,
  /^(early|new grad|university) (career|jobs?|opportunities|programs)/i,
  /^applicant (privacy|notice|rights)/i,
  /^equal (employment )?opportunity/i,
  /^fraud (alert|warning)/i,
  /^read more\.?$/i,
  /^learn more\.?$/i,
  /^see more\.?$/i,
  /^view details?$/i,
  /^apply (now|here|today|online)/i,
  /^how to apply$/i,
  /^sign in$/i,
  /^login$/i,
  // Pure single-word category names that get pulled as nav links
  /^(business|engineering|technology|sales|marketing|operations|finance|legal|hr|human resources|administration|manufacturing|research|design|product|customer support|customer service|information technology|cybersecurity|security|supply chain|logistics|procurement|construction|maintenance|quality)$/i,
  // Cute catch-alls
  /^(sweden|spain|united states|united kingdom|germany|france|italy|japan|china|india|brazil|mexico|canada|australia|netherlands|poland|singapore|ireland|portugal|switzerland|swedish|spanish|english|italian|german|french|portuguese|mandarin|cantonese|japanese|korean|hindi|arabic) \(english\)$/i,
];

function isNavTitle(t) {
  if (!t) return false;
  const s = String(t).trim();
  if (!s) return false;
  for (const re of NAV_TITLE_RE_LIST) if (re.test(s)) return true;
  return false;
}

export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);

  await ensureSchema(env);
  const db = env.JOBS_DB;

  // Optional ?dry_run=1 to preview
  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dry_run") === "1";

  // Page through all active jobs in chunks
  let scanned = 0;
  let toDelete = [];
  let cursor = 0;
  const CHUNK = 500;
  while (true) {
    const rows = await db.prepare(`
      SELECT id, title FROM job
      WHERE is_active = 1 AND id > ?
      ORDER BY id ASC
      LIMIT ?
    `).bind(cursor, CHUNK).all().catch(() => ({ results: [] }));
    const items = rows.results || [];
    if (items.length === 0) break;
    for (const r of items) {
      scanned += 1;
      if (isNavTitle(r.title)) toDelete.push(r.id);
    }
    cursor = items[items.length - 1].id;
    if (items.length < CHUNK) break;
  }

  if (dryRun) {
    return json({ ok: true, dry_run: true, scanned, to_delete: toDelete.length, ids_sample: toDelete.slice(0, 25) }, 200, request, env);
  }

  let deletedJobs = 0;
  let deletedFits = 0;
  // Chunk the deletes so we don't blow past the SQL parameter limit (100).
  for (let i = 0; i < toDelete.length; i += 50) {
    const slice = toDelete.slice(i, i + 50);
    const placeholders = slice.map(() => "?").join(",");
    const f = await db.prepare(`DELETE FROM job_fit WHERE job_id IN (${placeholders})`).bind(...slice).run().catch(() => null);
    deletedFits += f?.meta?.changes || 0;
    const r = await db.prepare(`DELETE FROM job WHERE id IN (${placeholders})`).bind(...slice).run().catch(() => null);
    deletedJobs += r?.meta?.changes || 0;
  }

  // Update company.jobs_count for affected companies
  // (cheap: just recalculate from job table)
  await db.prepare(`
    UPDATE company SET jobs_count = (
      SELECT COUNT(*) FROM job WHERE job.company_id = company.id AND job.is_active = 1
    )
  `).run().catch(() => {});

  return json({
    ok: true,
    scanned,
    deleted_jobs: deletedJobs,
    deleted_fits: deletedFits,
    remaining: scanned - deletedJobs,
  }, 200, request, env);
}

export async function onRequestGet({ request, env }) {
  return onRequestPost({ request, env });
}
