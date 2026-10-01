-- 0023_brand.sql
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

