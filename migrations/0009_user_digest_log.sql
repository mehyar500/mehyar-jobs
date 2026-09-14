-- 0009_user_digest_log.sql
-- Tracks per-user digest deliveries so cron retries never double-send.

CREATE TABLE IF NOT EXISTS user_digest_log (
  user_id            INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  scan_day           TEXT NOT NULL,
  sent_at            TEXT NOT NULL DEFAULT (datetime('now')),
  match_count        INTEGER NOT NULL DEFAULT 0,
  strong_match_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, scan_day)
);
