-- Durable daily scan boundaries plus the email outbox for the new-jobs digest.
-- A scan records job-id watermarks, so the digest includes exactly the rows
-- inserted during that scan (contract and regular employment alike).

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
  ON daily_job_digest(source_sync_status, scan_day);
