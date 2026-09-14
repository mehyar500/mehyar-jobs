-- 0022_landing_rotation.sql
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
