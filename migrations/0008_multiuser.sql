-- 0008_multiuser.sql
-- Public multi-user support: accounts, per-user resumes, per-user fit
-- profiles, and per-user job scores. The legacy single-user `profile`
-- table (id = 1) is left untouched — it remains the owner's admin config
-- and the source his account is seeded from (see ensureOwnerAccount in
-- functions/_shared/userAuth.js).

-- ── ACCOUNTS ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_user (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  username           TEXT UNIQUE,                 -- 'mehyar500' for the owner; NULL for public users
  email              TEXT NOT NULL UNIQUE,
  password_hash      TEXT NOT NULL,               -- pbkdf2-sha256$iter$b64salt$b64hash, or 'env-admin' (owner: authenticated via admin env login)
  display_name       TEXT,
  is_admin           INTEGER NOT NULL DEFAULT 0,
  newsletter_opt_in  INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_app_user_email    ON app_user(email);
CREATE INDEX IF NOT EXISTS idx_app_user_username ON app_user(username);

-- ── RESUMES (one or more per user; is_active = the one used for scoring)
CREATE TABLE IF NOT EXISTS user_resume (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  filename           TEXT,
  mime               TEXT,
  base64             TEXT,
  text               TEXT,
  is_active          INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_resume_user ON user_resume(user_id, is_active);

-- ── PER-USER FIT PROFILE (mirrors the fit-relevant columns of `profile`)
CREATE TABLE IF NOT EXISTS user_profile (
  user_id                   INTEGER PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  target_titles_json        TEXT NOT NULL DEFAULT '[]',
  keywords_json             TEXT NOT NULL DEFAULT '[]',
  exclude_keywords_json     TEXT NOT NULL DEFAULT '[]',
  locations_json            TEXT NOT NULL DEFAULT '[]',
  remote_required           INTEGER NOT NULL DEFAULT 0,
  min_salary_usd            INTEGER,
  preferred_industries_json TEXT NOT NULL DEFAULT '[]',
  excluded_industries_json  TEXT NOT NULL DEFAULT '[]',
  notes                     TEXT,
  updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── PER-USER JOB SCORES ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_job_fit (
  user_id            INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  job_id             INTEGER NOT NULL REFERENCES job(id) ON DELETE CASCADE,
  score              INTEGER NOT NULL,
  reasons            TEXT NOT NULL,
  hard_no            INTEGER NOT NULL DEFAULT 0,
  hard_no_reason     TEXT,
  scored_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, job_id)
);

CREATE INDEX IF NOT EXISTS idx_user_job_fit_user_score ON user_job_fit(user_id, score DESC);
