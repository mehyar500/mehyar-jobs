-- 0017_email_warmup.sql
-- Daily send-list algorithm for the email warm-up funnel.
-- Engagement-scored contacts, Fibonacci-level gating, provider pacing,
-- pruning/sunset rules, seed-test pre-send gate, and ESP abstraction
-- (SMTP2GO for aged cohorts, Brevo for warm/fresh segments).
-- Dry-run by default: nothing sends unless EMAIL_LIVE=1.

-- ── EMAIL CONTACTS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_contact (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  email              TEXT NOT NULL UNIQUE,              -- lowercased
  status             TEXT NOT NULL DEFAULT 'pending',   -- pending|active|opted_out|suppressed|sunset
  source             TEXT NOT NULL DEFAULT 'legacy',    -- legacy | mehyar_jobs | web
  first_name         TEXT,
  last_name          TEXT,
  city               TEXT,
  state              TEXT,
  role_title         TEXT,                              -- legacy role hint for job matching
  provider           TEXT NOT NULL DEFAULT 'other',     -- gmail|outlook|yahoo|apple|other
  user_id            INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  consent_log_json   TEXT NOT NULL DEFAULT '[]',        -- [{ts, language, source}]
  sent_count         INTEGER NOT NULL DEFAULT 0,
  last_sent_at       TEXT,
  week_sent_count    INTEGER NOT NULL DEFAULT 0,
  week_start         TEXT,                              -- ISO week of week_sent_count
  imported_at        TEXT NOT NULL DEFAULT (datetime('now')),
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_contact_status   ON email_contact(status);
CREATE INDEX IF NOT EXISTS idx_email_contact_provider ON email_contact(provider);
CREATE INDEX IF NOT EXISTS idx_email_contact_imported ON email_contact(imported_at DESC);

-- ── PER-ADDRESS ENGAGEMENT ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contact_engagement (
  contact_id           INTEGER PRIMARY KEY REFERENCES email_contact(id) ON DELETE CASCADE,
  opens                INTEGER NOT NULL DEFAULT 0,
  clicks               INTEGER NOT NULL DEFAULT 0,
  mpp_suspect_opens    INTEGER NOT NULL DEFAULT 0,     -- Apple-proxy opens, down-weighted
  last_open_at         TEXT,                            -- only non-suspect opens
  last_click_at        TEXT,
  engagement_band      TEXT NOT NULL DEFAULT 'fresh',   -- fresh|high|moderate|at_risk|inactive
  sends_since_engagement INTEGER NOT NULL DEFAULT 0,
  winback_stage        INTEGER NOT NULL DEFAULT 0,      -- 0..3 win-back emails sent
  suppressed_at        TEXT,
  suppress_reason      TEXT,                            -- hard_bounce|complaint|unsubscribed|sunset
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_engagement_band ON contact_engagement(engagement_band);

-- ── SEND LOG (every attempt, incl. dry runs) ───────────────────────
CREATE TABLE IF NOT EXISTS email_send (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id    INTEGER NOT NULL REFERENCES email_contact(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                          -- warmup|repermission|winback|digest|promo
  template      TEXT NOT NULL DEFAULT 'daily_digest',
  variant       TEXT NOT NULL DEFAULT 'standard',       -- standard | winback
  subject       TEXT,
  provider_used TEXT,                                   -- smtp2go | brevo | dry_run
  status        TEXT NOT NULL DEFAULT 'dry_run',        -- dry_run|queued|sent|failed
  scheduled_for TEXT,
  sent_at       TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_send_contact ON email_send(contact_id);
CREATE INDEX IF NOT EXISTS idx_email_send_status ON email_send(status);

-- ── WEBHOOK EVENTS (opens/clicks/bounces/complaints/unsubscribes) ──
CREATE TABLE IF NOT EXISTS email_event (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id  INTEGER NOT NULL REFERENCES email_contact(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                            -- open|click|hard_bounce|soft_bounce|complaint|unsubscribe
  mpp_suspect INTEGER NOT NULL DEFAULT 0,
  meta_json   TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_event_contact ON email_event(contact_id);
CREATE INDEX IF NOT EXISTS idx_email_event_kind    ON email_event(kind);

-- ── FIBONACCI GATE STATE ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fib_gate (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  level_idx          INTEGER NOT NULL DEFAULT 0,        -- index into FIB levels
  level              INTEGER NOT NULL DEFAULT 5,        -- current daily cap
  status             TEXT NOT NULL DEFAULT 'ramping',   -- ramping|holding|paused
  hold_until         TEXT,                              -- don't advance before this
  postmaster_reputation TEXT,                           -- High|Medium|Low|Bad (manual entry)
  last_complaint_pct REAL,
  last_bounce_pct    REAL,
  blocklist_hits     INTEGER NOT NULL DEFAULT 0,
  last_evaluated_at  TEXT,
  notes              TEXT
);
INSERT OR IGNORE INTO fib_gate (id, level_idx, level, status) VALUES (1, 0, 5, 'ramping');

-- ── SEED-TEST RECORDS (pre-send gate; manual entry for now) ────────
CREATE TABLE IF NOT EXISTS seed_test (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  template   TEXT NOT NULL,
  inbox_pct  REAL NOT NULL,
  spam_pct   REAL NOT NULL,
  tested_at  TEXT NOT NULL DEFAULT (datetime('now')),
  notes      TEXT
);
CREATE INDEX IF NOT EXISTS idx_seed_test_template ON seed_test(template, tested_at DESC);
