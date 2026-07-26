-- 0004_queue_and_capture.sql
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
);
