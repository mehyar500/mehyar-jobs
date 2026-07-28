// Embedded migration SQL. Loaded by db.js ensureSchema().
// Source of truth: /migrations/*.sql — keep them in sync.

export const MIGRATION_0001 = `-- 0001_init.sql
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

CREATE INDEX IF NOT EXISTS idx_alert_unread ON alert(is_read, created_at DESC);`;

export const MIGRATION_0002 = `-- 0002_applications.sql
-- Application tracking: per (user, job) record. One row per job you
-- decide to pursue, with draft state + submitted state + audit trail.
--
-- Workflow:
--   1. User clicks "Apply" on a job card → POST /api/admin/applications
--      creates a row with status="draft" + a generated cover_letter +
--      a JSON map of custom_answers. Server returns the draft.
--   2. User reviews the draft in the Applications tab. They can edit
--      cover_letter + each custom answer in place (PATCH).
--   3. User clicks "Submit" → POST /api/admin/applications/{id}/submit
--      → status="submitting" → server tries the actual ATS submit
--      endpoint (if available) or just opens the URL in a mailto/onclick
--      + records the submission + sends an email notification.
--   4. status moves to "submitted" or "failed".
--
-- For ATSs without a public submit API (most of them, actually), the
-- "submit" step records the canonical ATS URL the user should visit and
-- sends the email; the user opens the link in a new tab and uses the
-- already-prepared cover letter + answers to fill in the form.
--
-- The email notification is the user's confirmation that the application
-- was logged. It also includes a deep link to update the status manually
-- if the actual ATS submit happens outside the app.

CREATE TABLE IF NOT EXISTS application (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id             INTEGER NOT NULL REFERENCES job(id) ON DELETE CASCADE,
  status             TEXT    NOT NULL DEFAULT 'draft', -- draft|submitting|submitted|failed|withdrawn
  cover_letter       TEXT,                            -- the prepared cover letter text
  custom_answers     TEXT    NOT NULL DEFAULT '{}',   -- JSON map {question: answer}
  resume_snapshot    TEXT,                            -- the resume text used
  submission_method  TEXT,                            -- "ats_api"|"external_link"|"email"|"manual"
  submission_url     TEXT,                            -- canonical URL to actually submit (if external_link)
  ats_response       TEXT,                            -- JSON of the ATS API response (if any)
  notes              TEXT,                            -- free-form user notes
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  submitted_at       TEXT,
  email_sent_at      TEXT,
  email_id           TEXT,                            -- CF email service message id
  UNIQUE(job_id)                                       -- one application per job (latest wins on resubmit)
);

CREATE INDEX IF NOT EXISTS idx_application_job_id       ON application(job_id);
CREATE INDEX IF NOT EXISTS idx_application_status       ON application(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_application_created      ON application(created_at DESC);

-- Per-application event audit (status transitions, edits, etc.)
CREATE TABLE IF NOT EXISTS application_event (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id     INTEGER NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  kind               TEXT    NOT NULL,                -- "created"|"updated"|"submitted"|"submitted_ok"|"submitted_failed"|"email_sent"|"email_failed"|"withdrawn"
  detail             TEXT,                            -- free text
  created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_app_event_app ON application_event(application_id, created_at DESC);
`;

export const MIGRATION_0003 = `-- 0003_application_tracking.sql
-- Adds company-side confirmation tracking. The third-party company
-- sends the real "thank you for applying" email; we record when the
-- user marks that email as received.
--
-- Two ways to update company_confirmed_at:
--   1. Manual: user clicks "I got the company's email" on the
--      application detail page after seeing the confirmation in
--      their inbox.
--   2. Auto: user sets up a unique tracking email (app-{id}@jobs.mehyar.us)
--      in the company form instead of their personal one, and we have
--      a Worker that parses incoming mail and updates D1. Wired in
--      a future round; the column + index are here.

ALTER TABLE application ADD COLUMN company_confirmed_at TEXT;
ALTER TABLE application ADD COLUMN company_confirmed_source TEXT;  -- "manual"|"auto_email"
ALTER TABLE application ADD COLUMN company_email_subject TEXT;     -- the subject line the user saw
ALTER TABLE application ADD COLUMN tracking_email TEXT;           -- "app-123@jobs.mehyar.us" (optional, for auto-detect)
ALTER TABLE application ADD COLUMN next_action_at TEXT;            -- "follow up by" reminder
ALTER TABLE application ADD COLUMN follow_up_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_application_submitted      ON application(submitted_at);
CREATE INDEX IF NOT EXISTS idx_application_confirmed      ON application(company_confirmed_at, submitted_at);
CREATE INDEX IF NOT EXISTS idx_application_next_action    ON application(next_action_at);


-- ── Profile: extended fields for browser-based auto-fill ──
-- Stores the resume PDF/DOCX (base64), LinkedIn URL, GitHub URL,
-- portfolio URLs, work samples, plus a default set of form answers
-- (work auth, sponsorship, years of experience, etc.) the LLM
-- uses as ground truth when filling the company form.

ALTER TABLE profile ADD COLUMN resume_filename TEXT;
ALTER TABLE profile ADD COLUMN resume_mime      TEXT;             -- "application/pdf" | "application/msword"
ALTER TABLE profile ADD COLUMN resume_base64    TEXT;             -- the actual file, base64 encoded (<2 MB)
ALTER TABLE profile ADD COLUMN resume_text      TEXT;             -- plaintext version (for form-filling)
ALTER TABLE profile ADD COLUMN linkedin_url     TEXT;
ALTER TABLE profile ADD COLUMN github_url       TEXT;
ALTER TABLE profile ADD COLUMN portfolio_url    TEXT;
ALTER TABLE profile ADD COLUMN personal_website TEXT;
ALTER TABLE profile ADD COLUMN phone            TEXT;
ALTER TABLE profile ADD COLUMN city             TEXT;             -- current location
ALTER TABLE profile ADD COLUMN country          TEXT;
ALTER TABLE profile ADD COLUMN work_auth       TEXT;             -- "US Citizen" | "Green Card" | "Need Sponsorship" | etc.
ALTER TABLE profile ADD COLUMN years_experience INTEGER;
ALTER TABLE profile ADD COLUMN current_title    TEXT;
ALTER TABLE profile ADD COLUMN current_company  TEXT;
ALTER TABLE profile ADD COLUMN current_salary   INTEGER;
ALTER TABLE profile ADD COLUMN notice_period    TEXT;             -- "2 weeks" | "1 month" | "Immediately" etc.
ALTER TABLE profile ADD COLUMN gender           TEXT;
ALTER TABLE profile ADD COLUMN ethnicity         TEXT;
ALTER TABLE profile ADD COLUMN veteran_status   TEXT;
ALTER TABLE profile ADD COLUMN disability       TEXT;             -- voluntary self-identification
ALTER TABLE profile ADD COLUMN hispanic_latino  TEXT;             -- separate from ethnicity
ALTER TABLE profile ADD COLUMN cleartext_address TEXT;             -- for some forms
ALTER TABLE profile ADD COLUMN default_answers_json TEXT NOT NULL DEFAULT '{}';  -- {"how did you hear about us": "LinkedIn", ...}


-- ── Auto-submit runs (CF Browser Rendering sessions) ──
-- One row per headless attempt. Stores the full log, the form
-- fields that were filled, the final URL, whether the "thanks for
-- applying" page was detected, and the final screenshot as base64.

CREATE TABLE IF NOT EXISTS auto_submit_run (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id           INTEGER NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  status                   TEXT    NOT NULL DEFAULT 'running',  -- running|submitted|submitted_unconfirmed|failed
  started_at               TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at              TEXT,
  final_url                TEXT,
  confirmation_detected    INTEGER NOT NULL DEFAULT 0,           -- 1 if "thanks for applying" text seen
  log                      TEXT    NOT NULL DEFAULT '[]',        -- JSON array of {step, at, ...}
  form_filled              TEXT    NOT NULL DEFAULT '{}',        -- JSON {field_name: {value, source}}
  screenshot_base64        TEXT,                                -- base64 PNG of the post-submit page
  error                    TEXT
);

CREATE INDEX IF NOT EXISTS idx_auto_run_app          ON auto_submit_run(application_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_auto_run_status       ON auto_submit_run(status);


-- ── Email inbound log ──
-- Audit trail of every email we receive at info@mehyar.us (or
-- app-{id}@jobs.mehyar.us) via the /api/email/inbound webhook.
-- Even unmatched ones are recorded so we can see what came in.

CREATE TABLE IF NOT EXISTS email_inbound (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at             TEXT    NOT NULL DEFAULT (datetime('now')),
  from_addr               TEXT,
  to_addr                 TEXT,
  subject                 TEXT,
  body_excerpt            TEXT,
  matched_application_id  INTEGER REFERENCES application(id) ON DELETE SET NULL,
  matched_at              TEXT
);

CREATE INDEX IF NOT EXISTS idx_email_inbound_received  ON email_inbound(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_inbound_app      ON email_inbound(matched_application_id);
`;

export const MIGRATION_0004 = `-- 0004_queue_and_capture.sql
--
-- Adds the queue + capture fields the user asked for. Simplifies the
-- pipeline: the company emails the user, we just track what we sent
-- and when. No complicated inbound infrastructure.
--
-- New columns on application:
--   - salary_min_job / salary_max_job / salary_currency_job  : scraped from the job description
--   - cover_letter_sent   : the cover letter as it was actually submitted (snapshot)
--   - custom_answers_sent : the custom answers as they were actually submitted
--   - fields_filled_json  : every form field that the bot filled, with source (profile|llm|canonical)
--   - application_method  : "manual" | "browser_automation" | "deep_link"
--   - external_url        : the actual URL the user was sent to
--
-- New table: application_queue
--   - job_id, application_id, status (pending|in_flight|completed|failed|skipped)
--   - scheduled_at, started_at, finished_at
--   - dedup_key : UNIQUE (job_id) — prevents double-queueing the same job
--   - last_error

ALTER TABLE application ADD COLUMN salary_min_job INTEGER;
ALTER TABLE application ADD COLUMN salary_max_job INTEGER;
ALTER TABLE application ADD COLUMN salary_currency_job TEXT;
ALTER TABLE application ADD COLUMN cover_letter_sent TEXT;
ALTER TABLE application ADD COLUMN custom_answers_sent TEXT;
ALTER TABLE application ADD COLUMN fields_filled_json TEXT;
ALTER TABLE application ADD COLUMN application_method TEXT;
ALTER TABLE application ADD COLUMN external_url TEXT;

CREATE TABLE IF NOT EXISTS application_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id          INTEGER NOT NULL REFERENCES job(id) ON DELETE CASCADE,
  application_id  INTEGER REFERENCES application(id) ON DELETE SET NULL,
  status          TEXT    NOT NULL DEFAULT 'pending',  -- pending|in_flight|completed|failed|skipped
  priority        INTEGER NOT NULL DEFAULT 0,           -- higher = sooner
  scheduled_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  started_at      TEXT,
  finished_at     TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  dedup_key       TEXT    UNIQUE NOT NULL,              -- = job_id (prevents re-queueing same job)
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_queue_status       ON application_queue(status, priority DESC, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_queue_application  ON application_queue(application_id);
CREATE INDEX IF NOT EXISTS idx_queue_dedup        ON application_queue(dedup_key);

-- Daily counter: used to enforce 50/day cap
CREATE TABLE IF NOT EXISTS daily_counter (
  day          TEXT PRIMARY KEY,  -- YYYY-MM-DD
  submitted    INTEGER NOT NULL DEFAULT 0,
  succeeded    INTEGER NOT NULL DEFAULT 0,
  failed       INTEGER NOT NULL DEFAULT 0
);`;

export const MIGRATION_0005 = `-- 0005_profile_identity.sql
-- Required fields for a reviewed application draft. They are intentionally
-- separate from fit-scoring fields and are never used to rank jobs.

ALTER TABLE profile ADD COLUMN full_name TEXT;
ALTER TABLE profile ADD COLUMN email TEXT;`;
