-- 0012_job_alerts.sql
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
  ON job_alert (user_id, filters_json);
