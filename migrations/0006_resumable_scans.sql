-- Resumable scheduler state and engagement filtering.

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
  ON company(careers_kind, id);
