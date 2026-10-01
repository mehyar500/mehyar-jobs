-- 0024_warmup_tracking.sql
-- Per-brand email warmup campaign tracking (shared tables: every brand writes here).
-- Applied idempotently; safe to re-run.
CREATE TABLE IF NOT EXISTS warmup_campaign_sends(
  id INTEGER PRIMARY KEY,
  brand TEXT,
  campaign_day INTEGER,
  recipient_email TEXT,
  sent_at TEXT,
  status TEXT,
  message_id TEXT,
  source TEXT DEFAULT 'legacy-daily',
  opened_at TEXT,
  clicked_at TEXT,
  bounced_at TEXT
);
CREATE TABLE IF NOT EXISTS warmup_campaign_daily(
  brand TEXT,
  campaign_day INTEGER,
  date TEXT,
  planned_volume INTEGER,
  sent_count INTEGER,
  delivered_count INTEGER,
  open_count INTEGER,
  click_count INTEGER,
  bounce_count INTEGER,
  unsub_count INTEGER,
  PRIMARY KEY (brand, campaign_day)
);
CREATE INDEX IF NOT EXISTS idx_warmup_sends_email ON warmup_campaign_sends(recipient_email);
CREATE INDEX IF NOT EXISTS idx_warmup_sends_brand_day ON warmup_campaign_sends(brand, campaign_day);
