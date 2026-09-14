-- 0013_growth_engine.sql
-- Growth engine: employer featured posts, sponsor inventory (newsletter +
-- matches slots), shareable resume roasts (PII-stripped), and the referral
-- loop with bonus AI-chat credits. Job seekers stay free; money comes only
-- from employers / advertisers.

-- ── FEATURED (employer-paid) FLAGS ON JOBS ───────────────────────────
ALTER TABLE job ADD COLUMN featured INTEGER NOT NULL DEFAULT 0;
ALTER TABLE job ADD COLUMN featured_until TEXT;
ALTER TABLE job ADD COLUMN featured_note TEXT;
CREATE INDEX IF NOT EXISTS idx_job_featured ON job(featured, featured_until);

-- ── SPONSOR INVENTORY ────────────────────────────────────────────────
-- slot: 'email' (newsletter/alert email block) | 'matches' (top-match slot)
CREATE TABLE IF NOT EXISTS sponsor (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  headline    TEXT NOT NULL,
  body        TEXT,
  cta_text    TEXT NOT NULL DEFAULT 'Learn more',
  cta_url     TEXT NOT NULL,
  slot        TEXT NOT NULL DEFAULT 'email',
  job_id      INTEGER REFERENCES job(id) ON DELETE SET NULL,
  starts_at   TEXT,
  ends_at     TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sponsor_slot_active ON sponsor(slot, is_active);

-- ── FEATURED-POST REQUESTS (manual flow: employer asks, admin approves) ─
CREATE TABLE IF NOT EXISTS featured_request (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  job_url      TEXT,
  job_title    TEXT,
  message      TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── SHAREABLE RESUME ROASTS (PII-stripped by construction) ───────────
CREATE TABLE IF NOT EXISTS roast (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id      TEXT NOT NULL UNIQUE,
  user_id        INTEGER REFERENCES app_user(id) ON DELETE CASCADE,
  score          INTEGER,
  verdict        TEXT,
  strengths_json TEXT NOT NULL DEFAULT '[]',
  gaps_json      TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_roast_public ON roast(public_id);

-- ── REFERRAL LOOP ────────────────────────────────────────────────────
ALTER TABLE app_user ADD COLUMN referral_code TEXT;
ALTER TABLE app_user ADD COLUMN referred_by_code TEXT;
ALTER TABLE app_user ADD COLUMN chat_bonus_credits INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_user_referral_code ON app_user(referral_code);
CREATE TABLE IF NOT EXISTS referral_event (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_user_id INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  referred_user_id INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  bonus_chats      INTEGER NOT NULL DEFAULT 10,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_referral_event_referrer ON referral_event(referrer_user_id);
