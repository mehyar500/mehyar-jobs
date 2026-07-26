-- 0001_init.sql
-- mehyar-jobs D1 schema. Zero-secret: every company comes from public
-- lists (Fortune 500, Forbes Global 2000, Inc 5000, S&P 500) and the
-- career pages they self-publish. No API keys required.

-- ── COMPANY DIRECTORY ──────────────────────────────────────────────
-- The seed list is the source of truth. We deduplicate by (ticker, name).
-- "source" is the public ranking list (fortune_500 / forbes_g2000 /
-- inc_5000 / sp_500). Multiple sources for one company is allowed
-- (e.g. Apple appears in Fortune + Forbes + S&P).

CREATE TABLE IF NOT EXISTS company (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT    NOT NULL,             -- "Capital One"
  slug               TEXT    NOT NULL UNIQUE,      -- "capital-one"
  ticker             TEXT,
  rank               INTEGER,                       -- best rank across all lists
  source             TEXT    NOT NULL,             -- "fortune_500" | "forbes_g2000" | "inc_5000" | "sp_500"
  source_rank        INTEGER,                       -- rank within that list
  industry           TEXT,
  hq_country         TEXT,
  hq_state           TEXT,
  careers_url        TEXT,                          -- resolved career page
  careers_kind       TEXT,                          -- "greenhouse"|"lever"|"workday"|"ashby"|"smartrecruiters"|"recruiterflow"|"html"|"linkedin"|"unknown"
  careers_handle     TEXT,                          -- for ATS-style boards: e.g. "capitalone" for greenhouse
  scrape_status      TEXT    NOT NULL DEFAULT 'pending', -- pending|ok|broken|skipped
  scrape_last_at     TEXT,
  scrape_error       TEXT,
  jobs_count         INTEGER NOT NULL DEFAULT 0,
  notes              TEXT,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_company_slug          ON company(slug);
CREATE INDEX IF NOT EXISTS idx_company_source        ON company(source);
CREATE INDEX IF NOT EXISTS idx_company_careers_kind  ON company(careers_kind);
CREATE INDEX IF NOT EXISTS idx_company_scrape_status ON company(scrape_status);
CREATE INDEX IF NOT EXISTS idx_company_industry      ON company(industry);

-- ── JOB LISTINGS ───────────────────────────────────────────────────
-- One row per (company, external_id) job posting. Updated each scrape;
-- deleted if no longer present for N consecutive runs (TTL handled by
-- the crawler logic, not the DB).

CREATE TABLE IF NOT EXISTS job (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id         INTEGER NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  external_id        TEXT    NOT NULL,             -- board-specific stable id
  source_kind        TEXT    NOT NULL,             -- "greenhouse"|... — mirrors company.careers_kind
  url                TEXT    NOT NULL,             -- canonical job URL
  title              TEXT    NOT NULL,
  department         TEXT,
  team               TEXT,
  location           TEXT,
  remote_policy      TEXT,                          -- "remote"|"hybrid"|"onsite"|"unknown"
  employment_type    TEXT,                          -- "full_time"|"part_time"|"contract"|"intern"
  salary_min         INTEGER,
  salary_max         INTEGER,
  salary_currency    TEXT,
  posted_at          TEXT,
  first_seen_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  last_seen_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  description        TEXT,                          -- full HTML or plain
  description_text   TEXT,                          -- plain text version
  raw_json           TEXT,                          -- full source blob (JSON)
  is_active          INTEGER NOT NULL DEFAULT 1,
  UNIQUE(company_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_job_company_id    ON job(company_id);
CREATE INDEX IF NOT EXISTS idx_job_posted_at     ON job(posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_first_seen    ON job(first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_active        ON job(is_active, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_job_remote        ON job(remote_policy);
CREATE INDEX IF NOT EXISTS idx_job_title_search  ON job(title);

-- ── FIT SCORES ─────────────────────────────────────────────────────
-- One row per (job × profile_version). profile_version=1 for now.
-- Stored separately so we can re-score jobs cheaply if the profile
-- changes (no need to re-crawl).

CREATE TABLE IF NOT EXISTS job_fit (
  job_id             INTEGER PRIMARY KEY REFERENCES job(id) ON DELETE CASCADE,
  score              INTEGER NOT NULL,             -- 0-100
  reasons            TEXT    NOT NULL,             -- JSON array of strings
  hard_no            INTEGER NOT NULL DEFAULT 0,   -- 1 if a hard filter failed (location, clearance, etc.)
  hard_no_reason     TEXT,
  scored_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  profile_version    INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_job_fit_score  ON job_fit(score DESC);

-- ── USER PROFILE ───────────────────────────────────────────────────
-- Single-row config: target roles, skills, locations, comp floor,
-- industries, exclude keywords. Live-edited from /dash/settings.

CREATE TABLE IF NOT EXISTS profile (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  target_titles_json  TEXT    NOT NULL DEFAULT '[]',  -- ["Staff Engineer","AI Engineer",…]
  keywords_json       TEXT    NOT NULL DEFAULT '[]',  -- ["llm","agent","rag",…]
  exclude_keywords_json TEXT  NOT NULL DEFAULT '[]',  -- ["clearance required","phd only",…]
  locations_json      TEXT    NOT NULL DEFAULT '[]',  -- ["Remote","NYC","London",…]
  remote_required     INTEGER NOT NULL DEFAULT 0,
  min_salary_usd      INTEGER,
  preferred_industries_json TEXT NOT NULL DEFAULT '[]',
  excluded_industries_json  TEXT NOT NULL DEFAULT '[]',
  notes               TEXT,
  updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO profile (id) VALUES (1);

-- ── SCRAPE RUNS ────────────────────────────────────────────────────
-- Audit trail of cron jobs.

CREATE TABLE IF NOT EXISTS scrape_run (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at        TEXT,
  companies_attempted INTEGER NOT NULL DEFAULT 0,
  companies_succeeded INTEGER NOT NULL DEFAULT 0,
  companies_failed   INTEGER NOT NULL DEFAULT 0,
  jobs_found         INTEGER NOT NULL DEFAULT 0,
  new_jobs           INTEGER NOT NULL DEFAULT 0,
  removed_jobs       INTEGER NOT NULL DEFAULT 0,
  trigger            TEXT,                          -- "cron"|"manual"
  duration_ms        INTEGER,
  notes              TEXT
);

CREATE INDEX IF NOT EXISTS idx_scrape_run_started ON scrape_run(started_at DESC);

-- ── ALERTS ─────────────────────────────────────────────────────────
-- Sticky notifications on /dash/jobs.

CREATE TABLE IF NOT EXISTS alert (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  kind               TEXT    NOT NULL,             -- "new_job"|"high_fit"|"scraper_broken"
  job_id             INTEGER REFERENCES job(id) ON DELETE CASCADE,
  message            TEXT    NOT NULL,
  is_read            INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_alert_unread ON alert(is_read, created_at DESC);