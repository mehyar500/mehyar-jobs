-- 0017_email_warmup.sql
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

