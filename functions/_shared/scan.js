import { SEED_COMPANIES } from "../_lib/data/seed_companies.js";
import { scrapeCompany, inferEmploymentType } from "../_lib/scrapers/index.js";
import { extractSalary } from "./salary.js";
import { loadProfile, scoreJob } from "./fit.js";

const CONTRACT_QUERIES = [
  "full stack engineer",
  "backend engineer",
  "platform engineer",
  "devops engineer",
  "AI engineer",
  "React TypeScript",
];

export async function syncSeedCompanies(db) {
  const { unique, duplicates } = uniqueSeedCompanies(SEED_COMPANIES);
  const statements = unique.map((c) => db.prepare(`
    INSERT INTO company
      (name, slug, ticker, source, source_rank, industry, hq_country, hq_state, careers_url, careers_kind, careers_handle, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(slug) DO UPDATE SET
      name = excluded.name,
      ticker = COALESCE(excluded.ticker, company.ticker),
      source = excluded.source,
      source_rank = excluded.source_rank,
      industry = COALESCE(excluded.industry, company.industry),
      hq_country = COALESCE(excluded.hq_country, company.hq_country),
      hq_state = COALESCE(excluded.hq_state, company.hq_state),
      careers_url = excluded.careers_url,
      careers_kind = excluded.careers_kind,
      careers_handle = excluded.careers_handle,
      updated_at = datetime('now')
  `).bind(
    c.name, c.slug, c.ticker || null, c.source, c.source_rank || null,
    c.industry || null, c.hq_country || null, c.hq_state || null,
    c.careers_url || null, c.careers_kind || "unknown", c.careers_handle || null,
  ));
  await runBatches(db, statements, 50);
  for (const duplicate of duplicates) {
    const row = await db.prepare("SELECT id FROM company WHERE slug = ?").bind(duplicate.slug).first();
    if (!row?.id) continue;
    await db.batch([
      db.prepare("UPDATE company SET careers_kind = 'skipped', scrape_status = 'skipped', scrape_error = 'duplicate_source', jobs_count = 0, updated_at = datetime('now') WHERE id = ?").bind(row.id),
      db.prepare("UPDATE job SET is_active = 0 WHERE company_id = ?").bind(row.id),
    ]);
  }
  return unique.length;
}

export async function scanCompanyBatch(env, options = {}) {
  const db = env.JOBS_DB;
  const afterId = Math.max(0, Number(options.afterId || 0));
  const limit = Math.max(1, Math.min(10, Number(options.limit || 3)));
  const trigger = String(options.trigger || "manual").slice(0, 30);
  const startedAt = Date.now();
  const scanStamp = sqliteTimestamp(new Date(startedAt - 1000));
  const profile = await loadProfile(env);

  const rows = await db.prepare(`
    SELECT id, name, slug, careers_url, careers_kind, careers_handle, scrape_status, jobs_count
    FROM company
    WHERE id > ?
      AND careers_kind NOT LIKE 'feed_%'
      AND careers_kind NOT IN ('linkedin', 'skipped')
    ORDER BY id ASC
    LIMIT ?
  `).bind(afterId, limit).all();

  const companies = rows.results || [];
  const summary = {
    ok: true,
    attempted: companies.length,
    succeeded: 0,
    failed: 0,
    jobs_found: 0,
    new_jobs: 0,
    removed_jobs: 0,
    errors: [],
    cursor: afterId,
    next_cursor: null,
    done: companies.length === 0,
    duration_ms: 0,
  };

  for (const company of companies) {
    summary.cursor = company.id;
    const result = await scrapeCompany(company, { env }).catch((error) => ({ ok: false, error: error?.message || String(error) }));
    if (!result.ok) {
      summary.failed += 1;
      const error = String(result.error || "unknown").slice(0, 200);
      summary.errors.push({ company: company.name, error });
      await db.prepare("UPDATE company SET scrape_status = 'broken', scrape_last_at = datetime('now'), scrape_error = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(error, company.id).run();
      continue;
    }
    if (!(result.items || []).length && Number(company.jobs_count || 0) > 0) {
      summary.failed += 1;
      const error = "empty_result_preserved";
      summary.errors.push({ company: company.name, error });
      await db.prepare("UPDATE company SET scrape_status = 'broken', scrape_last_at = datetime('now'), scrape_error = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(error, company.id).run();
      continue;
    }

    const persisted = await persistCompanyJobs(env, company, result.items || [], scanStamp, profile);
    summary.succeeded += 1;
    summary.jobs_found += persisted.jobsFound;
    summary.new_jobs += persisted.newJobs;
    summary.removed_jobs += persisted.removedJobs;
  }

  if (companies.length > 0) {
    const remaining = await db.prepare(`
      SELECT id FROM company
      WHERE id > ? AND careers_kind NOT LIKE 'feed_%' AND careers_kind NOT IN ('linkedin', 'skipped')
      ORDER BY id ASC LIMIT 1
    `).bind(summary.cursor).first();
    summary.done = !remaining;
    summary.next_cursor = remaining ? summary.cursor : null;
  }

  summary.duration_ms = Date.now() - startedAt;
  await recordBatch(db, summary, trigger);
  return summary;
}

export async function syncContractJobs(env, options = {}) {
  const db = env.JOBS_DB;
  const profile = await loadProfile(env);
  const scanStamp = sqliteTimestamp(new Date(Date.now() - 1000));
  const queries = Array.isArray(options.queries) && options.queries.length ? options.queries : CONTRACT_QUERIES;
  const startedAt = Date.now();
  const responses = await Promise.allSettled(queries.map(fetchHimalayasContracts));
  const jobs = [];
  const errors = [];
  for (let index = 0; index < responses.length; index += 1) {
    const response = responses[index];
    if (response.status === "fulfilled") jobs.push(...response.value);
    else errors.push({ query: queries[index], error: String(response.reason?.message || response.reason).slice(0, 200) });
  }

  const unique = Array.from(new Map(jobs.filter((job) => job.guid && job.title && job.companyName).map((job) => [job.guid, job])).values());
  let inserted = 0;
  let updated = 0;
  for (const job of unique) {
    const companySlug = `himalayas-${slugify(job.companySlug || job.companyName)}`;
    await db.prepare(`
      INSERT INTO company
        (name, slug, source, industry, hq_country, careers_url, careers_kind, careers_handle, scrape_status, scrape_last_at, jobs_count, notes, updated_at)
      VALUES (?, ?, 'himalayas', ?, 'US', ?, 'feed_himalayas', ?, 'ok', datetime('now'), 0, 'Contract feed; attribution: Himalayas', datetime('now'))
      ON CONFLICT(slug) DO UPDATE SET
        name = excluded.name,
        careers_url = excluded.careers_url,
        scrape_status = 'ok',
        scrape_last_at = datetime('now'),
        updated_at = datetime('now')
    `).bind(job.companyName, companySlug, job.parentCategories?.[0] || "Technology", job.applicationLink, job.companySlug || null).run();
    const company = await db.prepare("SELECT id FROM company WHERE slug = ?").bind(companySlug).first();
    if (!company?.id) continue;

    const before = await db.prepare("SELECT id FROM job WHERE company_id = ? AND external_id = ?").bind(company.id, job.guid).first();
    const salaryIsAnnual = !job.salaryPeriod || /annual|year/i.test(job.salaryPeriod);
    const extractedSalary = extractSalary(`${job.title || ""} ${stripHtml(job.description || job.excerpt || "")}`);
    const location = Array.isArray(job.locationRestrictions) && job.locationRestrictions.length
      ? job.locationRestrictions.join(", ")
      : "Remote worldwide";
    await db.prepare(`
      INSERT INTO job
        (company_id, external_id, source_kind, url, title, department, team, location, remote_policy, employment_type,
         salary_min, salary_max, salary_currency, posted_at, last_seen_at, description, description_text, raw_json, is_active)
      VALUES (?, ?, 'himalayas', ?, ?, ?, NULL, ?, 'remote', 'contract', ?, ?, ?, ?, datetime('now'), NULL, ?, ?, 1)
      ON CONFLICT(company_id, external_id) DO UPDATE SET
        url = excluded.url,
        title = excluded.title,
        department = excluded.department,
        location = excluded.location,
        remote_policy = 'remote',
        employment_type = 'contract',
        salary_min = excluded.salary_min,
        salary_max = excluded.salary_max,
        salary_currency = excluded.salary_currency,
        posted_at = excluded.posted_at,
        last_seen_at = datetime('now'),
        description_text = excluded.description_text,
        raw_json = excluded.raw_json,
        is_active = 1
    `).bind(
      company.id,
      job.guid,
      job.applicationLink,
      job.title,
      job.parentCategories?.[0] || job.categories?.[0] || null,
      location,
      (salaryIsAnnual ? job.minSalary : null) || extractedSalary?.min || null,
      (salaryIsAnnual ? job.maxSalary : null) || extractedSalary?.max || null,
      (salaryIsAnnual ? job.currency : null) || extractedSalary?.currency || null,
      epochToIso(job.pubDate),
      stripHtml(job.description || job.excerpt || "").slice(0, 8000),
      JSON.stringify({ source: "himalayas", companySlug: job.companySlug, employmentType: job.employmentType, seniority: job.seniority, attribution: "https://himalayas.app" }),
    ).run();
    if (before) updated += 1;
    else inserted += 1;
  }

  const removed = errors.length === 0
    ? await db.prepare("UPDATE job SET is_active = 0 WHERE source_kind = 'himalayas' AND is_active = 1 AND last_seen_at < ?").bind(scanStamp).run()
    : { meta: { changes: 0 } };
  await db.prepare(`
    UPDATE company
    SET jobs_count = (SELECT COUNT(*) FROM job WHERE job.company_id = company.id AND job.is_active = 1)
    WHERE careers_kind = 'feed_himalayas'
  `).run();
  const contractRows = await db.prepare(`
    SELECT j.id, j.title, j.description_text, j.location, j.remote_policy, j.salary_min, j.salary_max, j.posted_at, c.industry
    FROM job j JOIN company c ON c.id = j.company_id
    WHERE j.source_kind = 'himalayas' AND j.is_active = 1
  `).all();
  await scoreRows(db, contractRows.results || [], profile);

  return {
    ok: errors.length < queries.length,
    source: "himalayas",
    queries: queries.length,
    found: unique.length,
    inserted,
    updated,
    removed: removed?.meta?.changes || 0,
    errors,
    duration_ms: Date.now() - startedAt,
  };
}

async function persistCompanyJobs(env, company, items, scanStamp, profile) {
  const db = env.JOBS_DB;
  const valid = items.filter((item) => item?.url && item?.title && item?.external_id != null);
  const existingRows = await db.prepare("SELECT external_id FROM job WHERE company_id = ?").bind(company.id).all();
  const existing = new Set((existingRows.results || []).map((row) => String(row.external_id)));
  const statements = valid.map((item) => {
    const descriptionText = String(item.description_text || item.description || "").slice(0, 8000) || null;
    const salary = descriptionText ? extractSalary(descriptionText) : null;
    return db.prepare(`
      INSERT INTO job
        (company_id, external_id, source_kind, url, title, department, team, location, remote_policy, employment_type,
         salary_min, salary_max, salary_currency, posted_at, last_seen_at, description, description_text, raw_json, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL, ?, ?, 1)
      ON CONFLICT(company_id, external_id) DO UPDATE SET
        title = excluded.title,
        department = excluded.department,
        team = excluded.team,
        location = excluded.location,
        remote_policy = excluded.remote_policy,
        employment_type = excluded.employment_type,
        salary_min = COALESCE(excluded.salary_min, job.salary_min),
        salary_max = COALESCE(excluded.salary_max, job.salary_max),
        salary_currency = COALESCE(excluded.salary_currency, job.salary_currency),
        posted_at = excluded.posted_at,
        last_seen_at = datetime('now'),
        description_text = excluded.description_text,
        raw_json = excluded.raw_json,
        is_active = 1
    `).bind(
      company.id,
      String(item.external_id),
      company.careers_kind,
      item.url,
      item.title,
      item.department || null,
      item.team || null,
      item.location || null,
      item.remote_policy || "unknown",
      inferEmploymentType(item.employment_type, item.title, descriptionText || ""),
      salary?.min || null,
      salary?.max || null,
      salary?.currency || null,
      item.posted_at || null,
      descriptionText,
      JSON.stringify(item.raw || {}),
    );
  });
  await runBatches(db, statements, 50);

  const removed = await db.prepare("UPDATE job SET is_active = 0 WHERE company_id = ? AND is_active = 1 AND last_seen_at < ?")
    .bind(company.id, scanStamp).run();
  await db.prepare("UPDATE company SET scrape_status = 'ok', scrape_last_at = datetime('now'), scrape_error = NULL, jobs_count = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(valid.length, company.id).run();
  const scoreable = await db.prepare(`
    SELECT j.id, j.title, j.description_text, j.location, j.remote_policy, j.salary_min, j.salary_max, j.posted_at, c.industry
    FROM job j JOIN company c ON c.id = j.company_id
    WHERE j.company_id = ? AND j.is_active = 1
  `).bind(company.id).all();
  await scoreRows(db, scoreable.results || [], profile);

  return {
    jobsFound: valid.length,
    newJobs: valid.reduce((count, item) => count + (existing.has(String(item.external_id)) ? 0 : 1), 0),
    removedJobs: removed?.meta?.changes || 0,
  };
}

async function scoreRows(db, rows, profile) {
  const statements = rows.map((row) => {
    const out = scoreJob(row, profile, row.industry);
    return db.prepare(`
      INSERT INTO job_fit (job_id, score, reasons, hard_no, hard_no_reason, profile_version)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(job_id) DO UPDATE SET
        score = excluded.score,
        reasons = excluded.reasons,
        hard_no = excluded.hard_no,
        hard_no_reason = excluded.hard_no_reason,
        scored_at = datetime('now'),
        profile_version = 1
    `).bind(row.id, out.score, JSON.stringify(out.reasons), out.hard_no ? 1 : 0, out.hard_no_reason);
  });
  await runBatches(db, statements, 50);
}

async function fetchHimalayasContracts(query) {
  const url = new URL("https://himalayas.app/jobs/api/search");
  url.searchParams.set("employment_type", "Contractor");
  url.searchParams.set("country", "US");
  url.searchParams.set("q", query);
  url.searchParams.set("sort", "recent");
  url.searchParams.set("page", "1");
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "MehyarJobs/0.2 (+https://jobs.mehyar.us)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`himalayas_http_${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body.jobs)) throw new Error("himalayas_invalid_response");
  return body.jobs;
}

async function recordBatch(db, summary, trigger) {
  await db.prepare(`
    INSERT INTO scrape_run
      (companies_attempted, companies_succeeded, companies_failed, jobs_found, new_jobs, removed_jobs, trigger, duration_ms, notes, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(
    summary.attempted,
    summary.succeeded,
    summary.failed,
    summary.jobs_found,
    summary.new_jobs,
    summary.removed_jobs,
    trigger,
    summary.duration_ms,
    JSON.stringify({ cursor: summary.cursor, next_cursor: summary.next_cursor, done: summary.done, errors: summary.errors }).slice(0, 4000),
  ).run();
}

async function runBatches(db, statements, size) {
  for (let index = 0; index < statements.length; index += size) {
    await db.batch(statements.slice(index, index + size));
  }
}

function sqliteTimestamp(value) {
  return value.toISOString().slice(0, 19).replace("T", " ");
}

function epochToIso(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const millis = numeric > 10_000_000_000 ? numeric : numeric * 1000;
  return new Date(millis).toISOString();
}

function slugify(value) {
  return String(value || "company").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || "company";
}

function uniqueSeedCompanies(companies) {
  const seen = new Set();
  const unique = [];
  const duplicates = [];
  for (const company of companies) {
    const sourceKey = company.careers_handle
      ? `${company.careers_kind}:${String(company.careers_handle).toLowerCase()}`
      : `${company.careers_kind}:${String(company.careers_url || company.slug).toLowerCase().replace(/\/$/, "")}`;
    if (seen.has(sourceKey)) duplicates.push(company);
    else {
      seen.add(sourceKey);
      unique.push(company);
    }
  }
  return { unique, duplicates };
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}
