-- 0014_sms_funnel.sql
-- Warm-up SMS funnel: consent-logged contacts, dry-run-safe sending,
-- engagement tracking (tapper vs non-tapper), offer-slot affiliate config,
-- recruiter lead-gen, and double-opt-in newsletter capture.
-- TCPA rule enforced in code: no number is messaged without a consent log.

-- ── SMS CONTACTS (consent is the gate) ──────────────────────────────
CREATE TABLE IF NOT EXISTS sms_contact (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_e164       TEXT NOT NULL UNIQUE,          -- +1XXXXXXXXXX
  status           TEXT NOT NULL DEFAULT 'pending', -- pending|active|opted_out
  deals_opt_in     INTEGER NOT NULL DEFAULT 0,    -- replied DEALS / marketing consent
  consent_log_json TEXT NOT NULL DEFAULT '[]',    -- [{ts, language, source}]
  tz_offset_min    INTEGER,                       -- recipient tz offset (minutes); null = assume ET
  segment          TEXT,                          -- tapper | non_tapper | NULL (unknown)
  last_tap_at      TEXT,
  sent_count       INTEGER NOT NULL DEFAULT 0,
  user_id          INTEGER REFERENCES app_user(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sms_contact_status ON sms_contact(status);
CREATE INDEX IF NOT EXISTS idx_sms_contact_segment ON sms_contact(segment);

-- ── SMS SEND LOG (every attempt, incl. dry runs) ────────────────────
CREATE TABLE IF NOT EXISTS sms_send (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id   INTEGER NOT NULL REFERENCES sms_contact(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,                     -- repermission|welcome|alert|promo|winback|help
  body         TEXT NOT NULL,
  segments     INTEGER NOT NULL DEFAULT 1,
  cost_cents   INTEGER NOT NULL DEFAULT 0,        -- estimated, 1.25c/segment
  status       TEXT NOT NULL DEFAULT 'dry_run',   -- queued|dry_run|sent|failed
  sid          TEXT,                              -- Twilio SID when actually sent
  scheduled_for TEXT,
  sent_at      TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sms_send_contact ON sms_send(contact_id);
CREATE INDEX IF NOT EXISTS idx_sms_send_status ON sms_send(status);

-- ── TRACKED LINKS (signed tap logging) ──────────────────────────────
CREATE TABLE IF NOT EXISTS sms_link (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id   TEXT NOT NULL UNIQUE,              -- token in /r/<id> and /o/<id>
  contact_id  INTEGER REFERENCES sms_contact(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'offer_page', -- offer_page | redirect
  target_url  TEXT NOT NULL,
  offer_slot  TEXT,                              -- offer_slot.key when this link is an offer CTA
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  tap_count   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sms_link_contact ON sms_link(contact_id);

CREATE TABLE IF NOT EXISTS sms_tap (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id    INTEGER NOT NULL REFERENCES sms_link(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES sms_contact(id) ON DELETE CASCADE,
  tapped_at  TEXT NOT NULL DEFAULT (datetime('now')),
  ip         TEXT,
  ua         TEXT
);
CREATE INDEX IF NOT EXISTS idx_sms_tap_link ON sms_tap(link_id);

-- ── OFFER SLOTS (affiliate config; cta_url empty = "coming soon") ────
CREATE TABLE IF NOT EXISTS offer_slot (
  key        TEXT PRIMARY KEY,                    -- resume_service|course|remote_board|bootcamp|coaching|sponsor_sms
  name       TEXT NOT NULL,
  slot_type  TEXT NOT NULL DEFAULT 'affiliate',   -- affiliate | sponsor
  headline   TEXT NOT NULL,
  body       TEXT,
  cta_text   TEXT NOT NULL DEFAULT 'Learn more',
  cta_url    TEXT,                                -- NULL/empty until Mayor pastes his approved link
  image_url  TEXT,
  sms_copy   TEXT,                                -- 160-char SMS variant
  priority   INTEGER NOT NULL DEFAULT 100,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO offer_slot (key, name, slot_type, headline, body, cta_text, sms_copy, priority) VALUES
('resume_service', 'AI Resume Review Partner', 'affiliate',
 'Get your resume professionally rewritten',
 'Upload your resume and a certified writer rebuilds it to beat ATS filters and impress hiring managers.',
 'Get my resume rewritten',
 'Pro resume writers rebuild your resume to beat ATS. Free review: ', 10),
('course', 'Skill-Gap Course Partner', 'affiliate',
 'Close your #1 skill gap this month',
 'Short, job-focused courses matched to the skills your top matches ask for.',
 'Browse matched courses',
 'Your top jobs want a skill you lack. Close the gap fast: ', 20),
('remote_board', 'Remote Jobs Board Partner', 'affiliate',
 'Hand-screened remote jobs, zero scams',
 'A paid remote-jobs board where every listing is vetted by humans — no spam, no scams.',
 'Try the remote board',
 'Tired of scam listings? Hand-screened remote jobs here: ', 30),
('bootcamp', 'Career-Switch Bootcamp Partner', 'affiliate',
 'Switch careers in months, not years',
 'Intensive, mentor-led programs with career outcomes — built for career switchers.',
 'Explore bootcamps',
 'Switch careers in months with a mentor-led bootcamp: ', 40),
('coaching', 'Career Coaching Partner', 'affiliate',
 '1:1 coaching from hiring insiders',
 'Mock interviews, salary negotiation, and a personal job-search plan from people who hire.',
 'Meet my coach',
 '1:1 coaching from hiring insiders. Mock interviews + offer negotiation: ', 50),
('sponsor_sms', 'Sponsored SMS Slot', 'sponsor',
 'Sponsored message',
 'Flat-fee sponsor placement inside SMS sends. Labeled "Sponsored" at render time.',
 'Learn more',
 '', 60);

-- ── RECRUITER LEADS (sellable later; no buyer wired) ─────────────────
CREATE TABLE IF NOT EXISTS recruiter_lead (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id   INTEGER REFERENCES sms_contact(id) ON DELETE SET NULL,
  name         TEXT,
  email        TEXT,
  phone        TEXT,
  title        TEXT,
  skills_json  TEXT NOT NULL DEFAULT '[]',
  location     TEXT,
  remote_ok    INTEGER NOT NULL DEFAULT 0,
  consent_text TEXT NOT NULL,                     -- exact language they agreed to
  consent_ts   TEXT NOT NULL DEFAULT (datetime('now')),
  status       TEXT NOT NULL DEFAULT 'new',       -- new | contacted | sold
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_recruiter_lead_status ON recruiter_lead(status);

-- ── NEWSLETTER SUBSCRIBERS (double opt-in, one-click unsubscribe) ───
CREATE TABLE IF NOT EXISTS newsletter_subscriber (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending|confirmed|unsubscribed
  source        TEXT,                              -- offer_page | signup | import
  confirm_token TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_newsletter_subscriber_status ON newsletter_subscriber(status);
