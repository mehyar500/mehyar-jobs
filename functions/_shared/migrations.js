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

export const MIGRATION_0006 = `-- 0006_resumable_scans.sql
CREATE TABLE IF NOT EXISTS scan_scheduler_state (
  name          TEXT PRIMARY KEY,
  scan_day      TEXT NOT NULL,
  cursor        INTEGER NOT NULL DEFAULT 0,
  completed_at  TEXT,
  last_error    TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_job_employment_type
  ON job(employment_type, is_active, posted_at DESC);

CREATE INDEX IF NOT EXISTS idx_company_feed_kind
  ON company(careers_kind, id);`;

export const MIGRATION_0007 = `-- 0007_daily_job_digest.sql
CREATE TABLE IF NOT EXISTS daily_job_digest (
  scan_day                  TEXT PRIMARY KEY,
  selection_mode            TEXT NOT NULL DEFAULT 'watermark',
  scan_started_at           TEXT NOT NULL,
  start_job_id              INTEGER NOT NULL DEFAULT 0,
  scan_completed_at         TEXT,
  end_job_id                INTEGER,
  source_sync_status        TEXT NOT NULL DEFAULT 'pending',
  source_sync_attempts      INTEGER NOT NULL DEFAULT 0,
  source_sync_claimed_at    TEXT,
  source_sync_completed_at  TEXT,
  source_sync_error         TEXT,
  email_status              TEXT NOT NULL DEFAULT 'pending',
  email_attempts            INTEGER NOT NULL DEFAULT 0,
  email_claimed_at          TEXT,
  email_sent_at             TEXT,
  email_message_id          TEXT,
  email_last_error          TEXT,
  email_error_code          TEXT,
  email_next_attempt_at     TEXT,
  recipient                 TEXT NOT NULL,
  job_count                 INTEGER NOT NULL DEFAULT 0,
  high_fit_count            INTEGER NOT NULL DEFAULT 0,
  contract_count            INTEGER NOT NULL DEFAULT 0,
  remote_count              INTEGER NOT NULL DEFAULT 0,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_daily_job_digest_delivery
  ON daily_job_digest(email_status, scan_completed_at, scan_day);

CREATE INDEX IF NOT EXISTS idx_daily_job_digest_sources
  ON daily_job_digest(source_sync_status, scan_day);`;

export const MIGRATION_0008 = `-- 0008_multiuser.sql
-- Public multi-user support: accounts, per-user resumes, per-user fit
-- profiles, and per-user job scores. The legacy single-user \`profile\`
-- table (id = 1) is left untouched — it remains the owner's admin config
-- and the source his account is seeded from (see ensureOwnerAccount in
-- functions/_shared/userAuth.js).

-- ── ACCOUNTS ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_user (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  username           TEXT UNIQUE,                 -- 'mehyar500' for the owner; NULL for public users
  email              TEXT NOT NULL UNIQUE,
  password_hash      TEXT NOT NULL,               -- pbkdf2-sha256$iter$b64salt$b64hash, or 'env-admin' (owner: authenticated via admin env login)
  display_name       TEXT,
  is_admin           INTEGER NOT NULL DEFAULT 0,
  newsletter_opt_in  INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_app_user_email    ON app_user(email);
CREATE INDEX IF NOT EXISTS idx_app_user_username ON app_user(username);

-- ── RESUMES (one or more per user; is_active = the one used for scoring)
CREATE TABLE IF NOT EXISTS user_resume (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  filename           TEXT,
  mime               TEXT,
  base64             TEXT,
  text               TEXT,
  is_active          INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_resume_user ON user_resume(user_id, is_active);

-- ── PER-USER FIT PROFILE (mirrors the fit-relevant columns of \`profile\`)
CREATE TABLE IF NOT EXISTS user_profile (
  user_id                   INTEGER PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  target_titles_json        TEXT NOT NULL DEFAULT '[]',
  keywords_json             TEXT NOT NULL DEFAULT '[]',
  exclude_keywords_json     TEXT NOT NULL DEFAULT '[]',
  locations_json            TEXT NOT NULL DEFAULT '[]',
  remote_required           INTEGER NOT NULL DEFAULT 0,
  min_salary_usd            INTEGER,
  preferred_industries_json TEXT NOT NULL DEFAULT '[]',
  excluded_industries_json  TEXT NOT NULL DEFAULT '[]',
  notes                     TEXT,
  updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── PER-USER JOB SCORES ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_job_fit (
  user_id            INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  job_id             INTEGER NOT NULL REFERENCES job(id) ON DELETE CASCADE,
  score              INTEGER NOT NULL,
  reasons            TEXT NOT NULL,
  hard_no            INTEGER NOT NULL DEFAULT 0,
  hard_no_reason     TEXT,
  scored_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, job_id)
);

CREATE INDEX IF NOT EXISTS idx_user_job_fit_user_score ON user_job_fit(user_id, score DESC);`;


export const MIGRATION_0009 = `-- 0009_user_digest_log.sql
-- Tracks per-user digest deliveries so cron retries never double-send.

CREATE TABLE IF NOT EXISTS user_digest_log (
  user_id            INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  scan_day           TEXT NOT NULL,
  sent_at            TEXT NOT NULL DEFAULT (datetime('now')),
  match_count        INTEGER NOT NULL DEFAULT 0,
  strong_match_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, scan_day)
);`;

export const MIGRATION_0010 = `-- 0010_llm_review.sql
-- Stores the LLM resume-review result on the user's resume row so it can be
-- shown on the /review page without re-running inference every visit.

ALTER TABLE user_resume ADD COLUMN llm_review_json TEXT;`;

export const MIGRATION_0011 = `-- 0011_anon_free_run.sql
-- One free resume check per anonymous visitor (IP-hashed), plus a daily
-- allowance of free AI generations (tailored resume / cover letter).
-- ip_hash is SHA-256(client_ip + server secret); no raw IPs stored.

CREATE TABLE IF NOT EXISTS anon_free_run (
  id         INTEGER PRIMARY KEY,
  ip_hash    TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'check',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_anon_free_run_ip_kind
  ON anon_free_run (ip_hash, kind, created_at);`;

export const MIGRATION_0012 = `-- 0012_job_alerts.sql
-- Free-funnel job alerts: a user saves a search (filters), and the daily
-- scanner emails them only the NEW jobs matching that search since the last
-- send. Watermark-based (last_sent_at) so each job alerts at most once.

CREATE TABLE IF NOT EXISTS job_alert (
  id               INTEGER PRIMARY KEY,
  user_id          INTEGER NOT NULL,
  name             TEXT NOT NULL,
  filters_json     TEXT NOT NULL DEFAULT '{}',
  is_active        INTEGER NOT NULL DEFAULT 1,
  last_sent_at     TEXT,
  last_match_count INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_job_alert_user_active
  ON job_alert (user_id, is_active);

-- One alert per user per identical filter set (prevents accidental dupes).
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_alert_user_filters
  ON job_alert (user_id, filters_json);`;

export const MIGRATION_0013 = `-- 0013_growth_engine.sql
-- Growth engine: employer featured posts, sponsor inventory (newsletter +
-- matches slots), shareable resume roasts (PII-stripped), and the referral
-- loop with bonus AI-chat credits. Job seekers stay free; money comes only
-- from employers / advertisers.

-- ── FEATURED (employer-paid) FLAGS ON JOBS ───────────────────────────
ALTER TABLE job ADD COLUMN featured INTEGER NOT NULL DEFAULT 0;
ALTER TABLE job ADD COLUMN featured_until TEXT;
ALTER TABLE job ADD COLUMN featured_note TEXT;
CREATE INDEX IF NOT EXISTS idx_job_featured ON job(featured, featured_until);

-- ── SPONSOR INVENTORY ────────────────────────────────────────────────
-- slot: 'email' (newsletter/alert email block) | 'matches' (top-match slot)
CREATE TABLE IF NOT EXISTS sponsor (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  headline    TEXT NOT NULL,
  body        TEXT,
  cta_text    TEXT NOT NULL DEFAULT 'Learn more',
  cta_url     TEXT NOT NULL,
  slot        TEXT NOT NULL DEFAULT 'email',
  job_id      INTEGER REFERENCES job(id) ON DELETE SET NULL,
  starts_at   TEXT,
  ends_at     TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sponsor_slot_active ON sponsor(slot, is_active);

-- ── FEATURED-POST REQUESTS (manual flow: employer asks, admin approves) ─
CREATE TABLE IF NOT EXISTS featured_request (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  job_url      TEXT,
  job_title    TEXT,
  message      TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── SHAREABLE RESUME ROASTS (PII-stripped by construction) ───────────
CREATE TABLE IF NOT EXISTS roast (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id      TEXT NOT NULL UNIQUE,
  user_id        INTEGER REFERENCES app_user(id) ON DELETE CASCADE,
  score          INTEGER,
  verdict        TEXT,
  strengths_json TEXT NOT NULL DEFAULT '[]',
  gaps_json      TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_roast_public ON roast(public_id);

-- ── REFERRAL LOOP ────────────────────────────────────────────────────
ALTER TABLE app_user ADD COLUMN referral_code TEXT;
ALTER TABLE app_user ADD COLUMN referred_by_code TEXT;
ALTER TABLE app_user ADD COLUMN chat_bonus_credits INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_user_referral_code ON app_user(referral_code);
CREATE TABLE IF NOT EXISTS referral_event (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_user_id INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  referred_user_id INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  bonus_chats      INTEGER NOT NULL DEFAULT 10,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_referral_event_referrer ON referral_event(referrer_user_id);`;

export const MIGRATION_0014 = `-- 0014_sms_funnel.sql
-- Warm-up SMS funnel: consent-logged contacts, dry-run-safe sending,
-- engagement tracking (tapper vs non-tapper), offer-slot affiliate config,
-- recruiter lead-gen, and double-opt-in newsletter capture.
-- TCPA rule enforced in code: no number is messaged without a consent log.

-- ── SMS CONTACTS (consent is the gate) ──────────────────────────────
CREATE TABLE IF NOT EXISTS sms_contact (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_e164       TEXT NOT NULL UNIQUE,          -- +1XXXXXXXXXX
  status           TEXT NOT NULL DEFAULT 'pending', -- pending|active|opted_out
  deals_opt_in     INTEGER NOT NULL DEFAULT 0,    -- replied DEALS / marketing consent
  consent_log_json TEXT NOT NULL DEFAULT '[]',    -- [{ts, language, source}]
  tz_offset_min    INTEGER,                       -- recipient tz offset (minutes); null = assume ET
  segment          TEXT,                          -- tapper | non_tapper | NULL (unknown)
  last_tap_at      TEXT,
  sent_count       INTEGER NOT NULL DEFAULT 0,
  user_id          INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sms_contact_status ON sms_contact(status);
CREATE INDEX IF NOT EXISTS idx_sms_contact_segment ON sms_contact(segment);

-- ── SMS SEND LOG (every attempt, incl. dry runs) ────────────────────
CREATE TABLE IF NOT EXISTS sms_send (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id   INTEGER NOT NULL REFERENCES sms_contact(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,                     -- repermission|welcome|alert|promo|winback|help
  body         TEXT NOT NULL,
  segments     INTEGER NOT NULL DEFAULT 1,
  cost_cents   INTEGER NOT NULL DEFAULT 0,        -- estimated, 1.25c/segment
  status       TEXT NOT NULL DEFAULT 'dry_run',   -- queued|dry_run|sent|failed
  sid          TEXT,                              -- Twilio SID when actually sent
  scheduled_for TEXT,
  sent_at      TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sms_send_contact ON sms_send(contact_id);
CREATE INDEX IF NOT EXISTS idx_sms_send_status ON sms_send(status);

-- ── TRACKED LINKS (signed tap logging) ──────────────────────────────
CREATE TABLE IF NOT EXISTS sms_link (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id   TEXT NOT NULL UNIQUE,              -- token in /r/<id> and /o/<id>
  contact_id  INTEGER REFERENCES sms_contact(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'offer_page', -- offer_page | redirect
  target_url  TEXT NOT NULL,
  offer_slot  TEXT,                              -- offer_slot.key when this link is an offer CTA
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  tap_count   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sms_link_contact ON sms_link(contact_id);

CREATE TABLE IF NOT EXISTS sms_tap (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id    INTEGER NOT NULL REFERENCES sms_link(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES sms_contact(id) ON DELETE CASCADE,
  tapped_at  TEXT NOT NULL DEFAULT (datetime('now')),
  ip         TEXT,
  ua         TEXT
);
CREATE INDEX IF NOT EXISTS idx_sms_tap_link ON sms_tap(link_id);

-- ── OFFER SLOTS (affiliate config; cta_url empty = "coming soon") ────
CREATE TABLE IF NOT EXISTS offer_slot (
  key        TEXT PRIMARY KEY,                    -- resume_service|course|remote_board|bootcamp|coaching|sponsor_sms
  name       TEXT NOT NULL,
  slot_type  TEXT NOT NULL DEFAULT 'affiliate',   -- affiliate | sponsor
  headline   TEXT NOT NULL,
  body       TEXT,
  cta_text   TEXT NOT NULL DEFAULT 'Learn more',
  cta_url    TEXT,                                -- NULL/empty until Mayor pastes his approved link
  image_url  TEXT,
  sms_copy   TEXT,                                -- 160-char SMS variant
  priority   INTEGER NOT NULL DEFAULT 100,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO offer_slot (key, name, slot_type, headline, body, cta_text, sms_copy, priority) VALUES
('resume_service', 'AI Resume Review Partner', 'affiliate',
 'Get your resume professionally rewritten',
 'Upload your resume and a certified writer rebuilds it to beat ATS filters and impress hiring managers.',
 'Get my resume rewritten',
 'Pro resume writers rebuild your resume to beat ATS. Free review: ', 10),
('course', 'Skill-Gap Course Partner', 'affiliate',
 'Close your #1 skill gap this month',
 'Short, job-focused courses matched to the skills your top matches ask for.',
 'Browse matched courses',
 'Your top jobs want a skill you lack. Close the gap fast: ', 20),
('remote_board', 'Remote Jobs Board Partner', 'affiliate',
 'Hand-screened remote jobs, zero scams',
 'A paid remote-jobs board where every listing is vetted by humans — no spam, no scams.',
 'Try the remote board',
 'Tired of scam listings? Hand-screened remote jobs here: ', 30),
('bootcamp', 'Career-Switch Bootcamp Partner', 'affiliate',
 'Switch careers in months, not years',
 'Intensive, mentor-led programs with career outcomes — built for career switchers.',
 'Explore bootcamps',
 'Switch careers in months with a mentor-led bootcamp: ', 40),
('coaching', 'Career Coaching Partner', 'affiliate',
 '1:1 coaching from hiring insiders',
 'Mock interviews, salary negotiation, and a personal job-search plan from people who hire.',
 'Meet my coach',
 '1:1 coaching from hiring insiders. Mock interviews + offer negotiation: ', 50),
('sponsor_sms', 'Sponsored SMS Slot', 'sponsor',
 'Sponsored message',
 'Flat-fee sponsor placement inside SMS sends. Labeled "Sponsored" at render time.',
 'Learn more',
 '', 60);

-- ── RECRUITER LEADS (sellable later; no buyer wired) ─────────────────
CREATE TABLE IF NOT EXISTS recruiter_lead (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id   INTEGER REFERENCES sms_contact(id) ON DELETE SET NULL,
  name         TEXT,
  email        TEXT,
  phone        TEXT,
  title        TEXT,
  skills_json  TEXT NOT NULL DEFAULT '[]',
  location     TEXT,
  remote_ok    INTEGER NOT NULL DEFAULT 0,
  consent_text TEXT NOT NULL,                     -- exact language they agreed to
  consent_ts   TEXT NOT NULL DEFAULT (datetime('now')),
  status       TEXT NOT NULL DEFAULT 'new',       -- new | contacted | sold
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_recruiter_lead_status ON recruiter_lead(status);

-- ── NEWSLETTER SUBSCRIBERS (double opt-in, one-click unsubscribe) ───
CREATE TABLE IF NOT EXISTS newsletter_subscriber (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending|confirmed|unsubscribed
  source        TEXT,                              -- offer_page | signup | import
  confirm_token TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_newsletter_subscriber_status ON newsletter_subscriber(status);
`;

export const MIGRATION_0015 = `-- 0015_product_slots.sql
-- 0015_product_slots.sql
-- Replace the generic offer-slot taxonomy with the 10 real affiliate
-- products. Each gets its own /go/<slug> review landing page. cta_url
-- stays empty until Mayor pastes his approved affiliate link
-- (AFFILIATE-LINK-NEEDED); pages render "coming soon" until then.

-- Retire the generic keys from 0014 (superseded by product slugs).
-- sponsor_sms is renamed to the hyphenated product-slug convention.
DELETE FROM offer_slot WHERE key IN ('resume_service', 'course', 'remote_board', 'bootcamp', 'coaching', 'sponsor_sms');

INSERT OR IGNORE INTO offer_slot (key, name, slot_type, headline, body, cta_text, sms_copy, priority) VALUES
('great-resumes-fast', 'Great Resumes Fast', 'affiliate',
 'Your resume, rewritten by a pro — in days',
 'Certified resume writers rebuild your resume around the jobs you actually want. ATS-proof formatting included.',
 'Get my rewrite',
 'Pro resume rewrite, done in days. See how it works: ', 10),
('myperfectresume', 'MyPerfectResume', 'affiliate',
 'Build a job-winning resume in 15 minutes',
 'Guided builder with recruiter-approved templates, pre-written bullet points, and a matching cover letter.',
 'Build my resume',
 'Build a recruiter-approved resume in 15 minutes: ', 15),
('designlab', 'Designlab', 'affiliate',
 'Mentor-led design courses that get you hired',
 '1-on-1 mentorship, real portfolio projects, and career coaching for designers switching or leveling up.',
 'Explore Designlab',
 'Mentor-led design courses with real portfolio projects: ', 20),
('coursera', 'Coursera Certificates', 'affiliate',
 'Career certificates from Google, Meta & IBM',
 'Job-ready certificates in IT, data, UX, and project management — the exact skills your matches ask for.',
 'Browse certificates',
 'Google & Meta career certificates that hiring managers respect: ', 25),
('udemy', 'Udemy', 'affiliate',
 'Close your skill gap for the price of lunch',
 'Thousands of job-focused courses, most under $20 on sale. Learn the one skill standing between you and the offer.',
 'Find my course',
 'The skill your top jobs want, taught for under $20: ', 30),
('skillshare', 'Skillshare', 'affiliate',
 'Learn the creative skills that get you noticed',
 'Project-based classes in design, video, and freelancing — build portfolio pieces while you learn.',
 'Start learning',
 'Project-based creative classes that build your portfolio: ', 35),
('flexjobs', 'FlexJobs', 'affiliate',
 'Hand-screened remote jobs — zero scams',
 'Every listing vetted by humans. 30,000+ remote, hybrid, and flexible jobs with the scams already removed.',
 'Browse remote jobs',
 'Hand-screened remote jobs, zero scams: ', 40),
('jobtestprep', 'JobTestPrep', 'affiliate',
 'Pass the assessment, land the job',
 'Practice tests for pre-employment assessments, aptitude tests, and interviews at 100+ major employers.',
 'Start practicing',
 'Practice the exact assessment they will give you: ', 45),
('amazon-gear', 'Interview Gear Bundle', 'affiliate',
 'Look the part on interview day',
 'My hand-picked interview kit: webcam, headset, lighting, and the shirt that photographs well on Zoom.',
 'Shop the bundle',
 'The interview kit I recommend — webcam, headset, lighting: ', 50),
('sponsor-sms', 'Sponsored SMS Slot', 'sponsor',
 'Sponsored message',
 'Flat-fee sponsor placement inside SMS sends and emails. Always labeled "Sponsored".',
 'Learn more',
 '', 60);
`;

export const MIGRATION_0016 = `-- 0016_consent_table.sql
-- 0016_consent_table.sql
-- Dedicated YES consent table — the ONLY entry gate to messaging.
--
-- HARD RULE (2026-09-13 compliance directive): no number or address is
-- ever messaged unless a logged YES exists HERE — with phone/email,
-- timestamp, the exact consent language, source cohort, and the
-- double-opt-in reply text. Broker-imported lists (no consent evidence
-- in their schema) import as status='pending' and stay silent until the
-- re-permission text ("reply DEALS") earns a YES, which is logged here.
--
-- A row in this table is proof of consent. sms_contact.consent_log_json
-- is kept as a human-readable mirror; this table is the gate.

CREATE TABLE IF NOT EXISTS sms_consent (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id         INTEGER REFERENCES sms_contact(id) ON DELETE CASCADE,
  phone_e164         TEXT NOT NULL,
  kind               TEXT NOT NULL,            -- repermission_yes | import_record
  consent_text       TEXT NOT NULL,            -- exact language they agreed to
  consent_ts         TEXT NOT NULL DEFAULT (datetime('now')),
  source_cohort      TEXT,                     -- broker_list | web | inbound | import
  double_optin_reply TEXT,                     -- the actual YES / DEALS / START text
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sms_consent_contact ON sms_consent(contact_id);
CREATE INDEX IF NOT EXISTS idx_sms_consent_phone ON sms_consent(phone_e164);
CREATE INDEX IF NOT EXISTS idx_sms_consent_kind ON sms_consent(kind);
`;

export const MIGRATION_0017 = `-- 0017_email_warmup.sql
-- Daily send-list algorithm for the email warm-up funnel.
-- Engagement-scored contacts, Fibonacci-level gating, provider pacing,
-- pruning/sunset rules, seed-test pre-send gate, and ESP abstraction
-- (SMTP2GO for aged cohorts, Brevo for warm/fresh segments).
-- Dry-run by default: nothing sends unless EMAIL_LIVE=1.

-- ── EMAIL CONTACTS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_contact (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  email              TEXT NOT NULL,
  brand              TEXT NOT NULL DEFAULT 'mehyar.jobs',
  status             TEXT NOT NULL DEFAULT 'pending',
  source             TEXT NOT NULL DEFAULT 'legacy',
  first_name         TEXT,
  last_name          TEXT,
  city               TEXT,
  state              TEXT,
  role_title         TEXT,
  provider           TEXT NOT NULL DEFAULT 'other',
  user_id            INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  consent_log_json   TEXT NOT NULL DEFAULT '[]',
  sent_count         INTEGER NOT NULL DEFAULT 0,
  last_sent_at       TEXT,
  week_sent_count    INTEGER NOT NULL DEFAULT 0,
  week_start         TEXT,
  imported_at        TEXT NOT NULL DEFAULT (datetime('now')),
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(email, brand)
);
CREATE INDEX IF NOT EXISTS idx_email_contact_status   ON email_contact(status);
CREATE INDEX IF NOT EXISTS idx_email_contact_brand_status ON email_contact(brand, status);
CREATE INDEX IF NOT EXISTS idx_email_contact_provider ON email_contact(provider);
CREATE INDEX IF NOT EXISTS idx_email_contact_imported ON email_contact(imported_at DESC);

-- ── PER-ADDRESS ENGAGEMENT ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contact_engagement (
  contact_id           INTEGER PRIMARY KEY REFERENCES email_contact(id) ON DELETE CASCADE,
  opens                INTEGER NOT NULL DEFAULT 0,
  clicks               INTEGER NOT NULL DEFAULT 0,
  mpp_suspect_opens    INTEGER NOT NULL DEFAULT 0,
  last_open_at         TEXT,
  last_click_at        TEXT,
  engagement_band      TEXT NOT NULL DEFAULT 'fresh',
  sends_since_engagement INTEGER NOT NULL DEFAULT 0,
  winback_stage        INTEGER NOT NULL DEFAULT 0,
  suppressed_at        TEXT,
  suppress_reason      TEXT,
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_engagement_band ON contact_engagement(engagement_band);

-- ── SEND LOG (every attempt, incl. dry runs) ───────────────────────
CREATE TABLE IF NOT EXISTS email_send (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id    INTEGER NOT NULL REFERENCES email_contact(id) ON DELETE CASCADE,
  brand         TEXT NOT NULL DEFAULT 'mehyar.jobs',
  kind          TEXT NOT NULL,
  template      TEXT NOT NULL DEFAULT 'daily_digest',
  variant       TEXT NOT NULL DEFAULT 'standard',
  subject       TEXT,
  provider_used TEXT,
  status        TEXT NOT NULL DEFAULT 'dry_run',
  scheduled_for TEXT,
  sent_at       TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_send_contact ON email_send(contact_id);
CREATE INDEX IF NOT EXISTS idx_email_send_status ON email_send(status);
CREATE INDEX IF NOT EXISTS idx_email_send_brand ON email_send(brand, status);

-- ── WEBHOOK EVENTS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_event (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id  INTEGER NOT NULL REFERENCES email_contact(id) ON DELETE CASCADE,
  brand       TEXT NOT NULL DEFAULT 'mehyar.jobs',
  kind        TEXT NOT NULL,
  mpp_suspect INTEGER NOT NULL DEFAULT 0,
  meta_json   TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_event_contact ON email_event(contact_id);
CREATE INDEX IF NOT EXISTS idx_email_event_kind    ON email_event(kind);
CREATE INDEX IF NOT EXISTS idx_email_event_brand   ON email_event(brand, kind);

-- ── FIBONACCI GATE STATE ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fib_gate (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  level_idx          INTEGER NOT NULL DEFAULT 0,
  level              INTEGER NOT NULL DEFAULT 5,
  status             TEXT NOT NULL DEFAULT 'ramping',
  hold_until         TEXT,
  postmaster_reputation TEXT,
  last_complaint_pct REAL,
  last_bounce_pct    REAL,
  blocklist_hits     INTEGER NOT NULL DEFAULT 0,
  last_evaluated_at  TEXT,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  notes              TEXT
);
INSERT OR IGNORE INTO fib_gate (id, level_idx, level, status) VALUES (1, 0, 5, 'ramping');

-- ── SEED-TEST RECORDS ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS seed_test (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  template   TEXT NOT NULL,
  inbox_pct  REAL NOT NULL,
  spam_pct   REAL NOT NULL,
  tested_at  TEXT NOT NULL DEFAULT (datetime('now')),
  notes      TEXT
);
CREATE INDEX IF NOT EXISTS idx_seed_test_template ON seed_test(template, tested_at DESC);
`;

export const MIGRATION_0018 = `-- 0018_product_catalog.sql
-- Product catalog for the email growth engine ("Mayor Jobs" Genius Flow).
-- A product is woven into the daily email; one product is "featured" per
-- day, rotated across categories (Mon..Fri) with a per-product cooldown.
--
-- NEVER invent ASINs: every non-NULL Amazon URL below was verified against
-- the repo's existing affiliate content (or web-verified the day it was
-- added). NULL url = ASIN lookup pending; active=0 until verified.
-- Products with approved=0 have UNAPPROVED affiliate programs — they must
-- not be featured or linked until the program application is accepted.

CREATE TABLE IF NOT EXISTS product_slot (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  category        TEXT NOT NULL,
  url             TEXT,
  image_url       TEXT,
  angles_json     TEXT NOT NULL DEFAULT '[]',
  cooldown_days   INTEGER NOT NULL DEFAULT 30,
  active          INTEGER NOT NULL DEFAULT 1,
  approved        INTEGER NOT NULL DEFAULT 1,
  last_featured_on TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_product_slot_category ON product_slot(category, active);
CREATE INDEX IF NOT EXISTS idx_product_slot_active ON product_slot(active, approved);

-- System flags: durable key/value switches (e.g. sender_armed timestamp).
-- EMAIL_LIVE is intentionally NOT stored here — it lives in the Pages env
-- so only a dashboard-level change flips the live switch.
CREATE TABLE IF NOT EXISTS system_flag (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO product_slot (slug, name, category, url, angles_json, notes) VALUES
('logitech-c920s', 'Logitech C920s Webcam', 'interview_gear',
 'https://www.amazon.com/dp/B07K986YLL?tag=mehyarus-20',
 '["stop looking like a hostage video on Zoom", "the $70 upgrade hiring managers actually notice", "look like you''re in the room, not in a basement"]',
 'verified ASIN from affiliate content'),
('fifine-k669', 'FIFINE K669 USB Microphone', 'interview_gear',
 'https://www.amazon.com/dp/B01MXL3EOU?tag=mehyarus-20',
 '["sound like you''re in the room", "the $35 fix for laptop-mic interviews", "what they hear is what they judge"]',
 'verified ASIN from affiliate content'),
('screenbar', 'Monitor Light Bar', 'desk_setup',
 'https://www.amazon.com/dp/B076VNFZJG?tag=mehyarus-20',
 '["your desk called, it wants an upgrade", "late-night applications without eye strain", "the setup that photographs well on LinkedIn"]',
 'verified ASIN from affiliate content'),
('mx-master', 'Logitech MX Master Mouse', 'desk_setup',
 'https://www.amazon.com/dp/B0B11LJ69K?tag=mehyarus-20',
 '["apply to 50 jobs without wrist pain", "the mouse every recruiter seems to own", "scroll less, apply more"]',
 'web-verified ASIN 2026-09-13'),
('ember-mug', 'Ember Temperature Control Mug', 'desk_setup',
 'https://www.amazon.com/dp/B0H2BHDDSV?tag=mehyarus-20',
 '["coffee stays hot through long applications", "small luxury for the job hunt grind", "your desk setup''s finishing touch"]',
 'web-verified ASIN 2026-09-13');

-- ASIN pending: URL NULL, inactive until verified.
INSERT OR IGNORE INTO product_slot (slug, name, category, url, angles_json, active, notes) VALUES
('ring-light', '10" Ring Light for video calls', 'interview_gear', NULL,
 '["never interview in the dark again", "the $25 lighting trick streamers use", "look awake on 8am calls"]',
 0,
 'ASIN lookup pending — verify via shopping skill before activating'),
('parachute-book', 'What Color Is Your Parachute? (book)', 'books', NULL,
 '["the career book that''s survived 50 years for a reason", "read this before your next pivot", "figure out what you actually want"]',
 0,
 'ASIN lookup pending — verify via shopping skill before activating');

-- UNAPPROVED affiliate programs: approved=0 AND active=0. Never feature,
-- never link until the program application is accepted.
INSERT OR IGNORE INTO product_slot (slug, name, category, url, angles_json, active, approved, notes) VALUES
('yotru', 'Yotru AI Resume Builder', 'resume',
 'https://yotru.com/affiliate',
 '["resumes that beat the ATS robots", "build a resume in 10 minutes, not 10 hours", "AI that writes what recruiters skim for"]',
 0, 0,
 'UNAPPROVED affiliate program — activate after acceptance'),
('jobtestprep', 'JobTestPrep', 'interview_prep',
 'https://www.jobtestprep.com/affiliates',
 '["practice the test before the test", "assessment day without the panic", "the prep site hiring managers know"]',
 0, 0,
 'UNAPPROVED — activate after acceptance');
`;


export const MIGRATION_0019 = `-- 0019_product_details.sql
-- Worker 1 (product enrichment), Genius Flow email engine.
--
-- Adds a factual 'description' column to product_slot, fills
-- descriptions for all 9 products, and activates the two ASINs verified
-- by opening the live Amazon dp pages (title match + product-info table):
--
--   B0FLJV1BVB  -> "NEEWER Basics 10" Selfie Ring Light with Tripod
--                   Stand/3 Phone Holders..." (ASIN confirmed in the page's
--                   product-information table)
--   1984861204  -> "What Color Is Your Parachute?: Your Guide to a Lifetime
--                   of Meaningful Work and Career Success" by Richard N.
--                   Bolles (ISBN-10 1984861204, ISBN-13 978-1984861207,
--                   Ten Speed Press, revised edition)
--
-- No 2026-edition ASIN could be confirmed from publisher/retailer sources,
-- so the book link points at the current in-print revised paperback above.
--
-- yotru / jobtestprep STAY approved=0 AND active=0 — their affiliate
-- programs are unapproved; they must not be featured or linked.
--
-- image_url left NULL for all products: there is no affiliate imagery in
-- this repo and Amazon CDN image URLs are not stable/guessable. Never
-- guess image URLs; populate image_url only from a verified source.

-- "only if missing": SQLite has no IF NOT EXISTS for ADD COLUMN, but the
-- migration runner records each migration in __migrations and never
-- re-applies it; the statement runner also ignores re-run errors.
ALTER TABLE product_slot ADD COLUMN description TEXT;

-- ── descriptions (factual, 1-2 sentences; no hype, no prices) ────────
UPDATE product_slot SET description =
 'A 1080p webcam with autofocus, dual microphones, and a built-in privacy shutter, made for video calls.'
WHERE slug = 'logitech-c920s';

UPDATE product_slot SET description =
 'A plug-and-play USB condenser microphone on a tripod stand, built for clearer voice on calls and recordings.'
WHERE slug = 'fifine-k669';

UPDATE product_slot SET description =
 'A light bar that mounts on top of a monitor to light the desk evenly without taking up space.'
WHERE slug = 'screenbar';

UPDATE product_slot SET description =
 'An ergonomic wireless mouse with a precision scroll wheel, built for long days of clicking.'
WHERE slug = 'mx-master';

UPDATE product_slot SET description =
 'A rechargeable mug that holds drinks at a chosen temperature via its companion app.'
WHERE slug = 'ember-mug';

UPDATE product_slot SET description =
 'A 10-inch LED ring light with tripod stand and phone holders: USB powered, with 3 color modes and 10 brightness levels.'
WHERE slug = 'ring-light';

UPDATE product_slot SET description =
 'Richard N. Bolles''s long-running career guide on job hunting and career change, covering networking, resumes, interviewing, and finding meaningful work.'
WHERE slug = 'parachute-book';

UPDATE product_slot SET description =
 'An AI-assisted resume builder for job seekers. Affiliate program not yet approved — do not link or feature.'
WHERE slug = 'yotru';

UPDATE product_slot SET description =
 'Practice tests for pre-employment assessments and aptitude tests. Affiliate program not yet approved — do not link or feature.'
WHERE slug = 'jobtestprep';

-- ── activate the two verified ASINs ─────────────────────────────────
UPDATE product_slot SET
  name = 'NEEWER Basics 10" Ring Light',
  url = 'https://www.amazon.com/dp/B0FLJV1BVB?tag=mehyarus-20',
  active = 1,
  approved = 1,
  notes = 'ASIN verified 2026-09-13: dp page title + product-info table match'
WHERE slug = 'ring-light';

UPDATE product_slot SET
  name = 'What Color Is Your Parachute?: Your Guide to a Lifetime of Meaningful Work and Career Success',
  url = 'https://www.amazon.com/dp/1984861204?tag=mehyarus-20',
  active = 1,
  approved = 1,
  notes = 'ASIN verified 2026-09-13: dp page title + ISBN match (ISBN-13 978-1984861207); current in-print revised paperback — no 2026-edition ASIN confirmed'
WHERE slug = 'parachute-book';
`;


export const MIGRATION_0020 = `-- 0020_email_send_meta.sql
-- Genius Flow skeleton tracking: meta_json on the send log so the
-- campaign report and product attribution can read meta_json.product
-- (product slug woven into that send) and meta_json.skeleton. The
-- write path must match what campaignReport.js reads from
-- email_event.meta_json.product -- recordEmailEvent copies the tag
-- from the latest product-woven send onto each engagement event.
ALTER TABLE email_send ADD COLUMN meta_json TEXT NOT NULL DEFAULT '{}';
`;

export const MIGRATION_0021 = `-- 0021_campaign_plan.sql
-- Campaign brain plans: one LLM-written plan row per day for the Genius
-- Flow email engine ("Mayor Jobs").
--
-- The brain (scanner worker, 06:30 ET cron) WRITES exactly one row per
-- date: the day's template mix, product-of-day override, subject tweaks,
-- and segment focus, plus a plain-English reasoning summary. The daily
-- sender READS the row and follows it; with no row it falls back to the
-- existing deterministic behavior.
--
-- HARD RULE: this table never triggers sends and never touches EMAIL_LIVE.

CREATE TABLE IF NOT EXISTS campaign_plan (
  plan_date      TEXT PRIMARY KEY,  -- YYYY-MM-DD
  plan_json      TEXT NOT NULL,     -- validated plan (skeleton mix, product, subjects, segment focus)
  reasoning_text TEXT NOT NULL,     -- plain-English 2-4 sentence summary from the LLM
  model          TEXT NOT NULL,     -- Workers AI model ("...:deterministic-fallback" when the LLM failed)
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);`;

export const MIGRATION_0022 = `-- 0022_landing_rotation.sql
-- Genius Flow landing rotation (Worker 6):
--   * signed preference landing pages (/pref/<token>)
--   * dated campaign slugs (/go/<date>-<token>)
--   * per-product gear pages (/gear/<slug>)
--   * per-slug attribution feeding the dashboard landing-stats API.
--
-- HARD RULES this migration upholds:
--   - OLD /go/<offer-slug> links keep resolving (dated slugs live in a
--     separate table + a date-prefixed pattern, so inboxes never break).
--   - email_consent follows the 0016 sms_consent pattern: a row is proof
--     of explicit YES consent; unchecked-by-default checkbox only.
--   - No ESP sends are touched here; this table set is read/click
--     attribution only.

-- ── DATED CAMPAIGN SLUGS ──────────────────────────────────────────
-- One row per day (idempotent get-or-create). The public URL is
--   /go/<date>-<token>   e.g. /go/2026-09-15-k7x2qm9a
-- carrying that day's campaign context (template mix, product of the day).
CREATE TABLE IF NOT EXISTS landing_slug (
  slug          TEXT PRIMARY KEY,                 -- "<date>-<token8>"
  date          TEXT NOT NULL,                    -- YYYY-MM-DD
  token         TEXT NOT NULL,
  page_type     TEXT NOT NULL DEFAULT 'go',       -- always 'go' here
  template      TEXT,                             -- day's campaign context (skeleton mix / segment focus)
  product_slug  TEXT,                             -- product_slot.slug featured that day
  product_angle TEXT,
  clicks        INTEGER NOT NULL DEFAULT 0,
  unique_clicks INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_landing_slug_date ON landing_slug(date);

-- ── RAW HIT LOG (per-slug attribution) ────────────────────────────
-- Every landing-page hit lands here; the landing-stats admin API
-- aggregates from it. visitor_key = "c<contact_id>" when the visitor is
-- identified (signed pref token), else a hash of the client IP — raw IPs
-- are never stored.
CREATE TABLE IF NOT EXISTS landing_hit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT NOT NULL,                      -- YYYY-MM-DD
  page_type   TEXT NOT NULL,                      -- 'go' | 'gear' | 'preference'
  slug        TEXT NOT NULL,                      -- go: "<date>-<token>"; gear: product slug; preference: 'preference'
  product_slug TEXT,
  contact_id  INTEGER REFERENCES email_contact(id) ON DELETE SET NULL,
  visitor_key TEXT,
  kind        TEXT NOT NULL DEFAULT 'click',      -- click | open
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_landing_hit_date ON landing_hit(date, page_type);
CREATE INDEX IF NOT EXISTS idx_landing_hit_slug ON landing_hit(slug, page_type);
CREATE INDEX IF NOT EXISTS idx_landing_hit_visitor ON landing_hit(slug, visitor_key);

-- ── EXPLICIT PREFERENCES (from the signed /pref/ page) ────────────
CREATE TABLE IF NOT EXISTS contact_preference (
  contact_id     INTEGER PRIMARY KEY REFERENCES email_contact(id) ON DELETE CASCADE,
  industries_json TEXT NOT NULL DEFAULT '[]',    -- e.g. ["technology","healthcare"]
  work_style      TEXT,                           -- remote | hybrid | on_site | NULL
  wants_json      TEXT NOT NULL DEFAULT '[]',     -- e.g. ["job_alerts","resume_review"]
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── EMAIL CONSENT LOG (0016 pattern, email side) ──────────────────
-- A row here is proof of explicit YES email consent, mirroring the
-- sms_consent gate. email_contact.consent_log_json stays as the
-- human-readable mirror.
CREATE TABLE IF NOT EXISTS email_consent (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id   INTEGER REFERENCES email_contact(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  kind         TEXT NOT NULL,                     -- preference_page_yes | repermission_yes
  consent_text TEXT NOT NULL,                     -- exact language they agreed to
  consent_ts   TEXT NOT NULL DEFAULT (datetime('now')),
  source_cohort TEXT,                             -- web | import
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_consent_contact ON email_consent(contact_id);
CREATE INDEX IF NOT EXISTS idx_email_consent_email ON email_consent(email);
`;

export const MIGRATION_0023 = `-- 0023_brand.sql
-- Brand-separated subscribers: every contact/send/event carries a brand
-- slug (mehyar.jobs | aimech.app | mehyar.us | rizza.app). One person can
-- exist on several brands' lists: UNIQUE(email, brand).
--
-- IDEMPOTENT: every statement is safe to re-run (IF NOT EXISTS /
-- OR IGNORE / ADD COLUMN error swallowed by the runner). NOTE: the
-- email_contact UNIQUE(email,brand) rebuild is NOT in this runner script —
-- D1 enforces FKs, so DROP+RENAME on a referenced parent SILENTLY DELETES
-- child rows (ON DELETE CASCADE). The rebuild was applied to production
-- directly; fresh databases get the new schema from MIGRATION_0017.

-- ── BRAND REGISTRY ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS brand (
  slug       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  domain     TEXT NOT NULL,
  from_email TEXT NOT NULL,
  from_name  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO brand (slug, name, domain, from_email, from_name) VALUES
  ('mehyar.jobs', 'Mehyar Jobs', 'jobs.mehyar.us', 'hello@mehyar.us', 'Mehyar Jobs'),
  ('aimech.app', 'AI Mechanic', 'aimech.app', 'hello@mehyar.us', 'AI Mechanic'),
  ('mehyar.us', 'MehyarSoft', 'mehyar.us', 'info@mehyar.us', 'MehyarSoft'),
  ('rizza.app', 'RIZZA', 'rizza.app', 'hello@mehyar.us', 'RIZZA');

-- ── BRAND COLUMNS (ADD COLUMN only — never rebuild referenced tables) ──
ALTER TABLE email_contact ADD COLUMN brand TEXT NOT NULL DEFAULT 'mehyar.jobs';
CREATE INDEX IF NOT EXISTS idx_email_contact_brand_status ON email_contact(brand, status);
ALTER TABLE email_send ADD COLUMN brand TEXT NOT NULL DEFAULT 'mehyar.jobs';
CREATE INDEX IF NOT EXISTS idx_email_send_brand ON email_send(brand, status);
ALTER TABLE email_event ADD COLUMN brand TEXT NOT NULL DEFAULT 'mehyar.jobs';
CREATE INDEX IF NOT EXISTS idx_email_event_brand ON email_event(brand, kind);
ALTER TABLE newsletter_subscriber ADD COLUMN brand TEXT NOT NULL DEFAULT 'mehyar.jobs';
`;
