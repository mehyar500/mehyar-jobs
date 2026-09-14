-- 0018_product_catalog.sql
-- Product catalog for the email growth engine ("Mayor Jobs" Genius Flow).
-- A product is woven into the daily email; one product is "featured" per
-- day, rotated across categories (Mon..Fri) with a per-product cooldown.
--
-- NEVER invent ASINs: every non-NULL Amazon URL below was verified against
-- the repo's existing affiliate content (or web-verified the day it was
-- added). NULL url = ASIN lookup pending; active=0 until verified.
-- Products with approved=0 have UNAPPROVED affiliate programs — they must
-- not be featured or linked until the program application is accepted.

CREATE TABLE IF NOT EXISTS product_slot (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  category        TEXT NOT NULL,                       -- interview_gear | desk_setup | books | resume | interview_prep | ...
  url             TEXT,                                -- affiliate link; NULL until verified
  image_url       TEXT,
  angles_json     TEXT NOT NULL DEFAULT '[]',          -- JSON array of copy angles (hooks)
  cooldown_days   INTEGER NOT NULL DEFAULT 30,         -- days before this product may be featured again
  active          INTEGER NOT NULL DEFAULT 1,          -- 0 = hidden from rotation (e.g. ASIN pending)
  approved        INTEGER NOT NULL DEFAULT 1,          -- 0 = affiliate program NOT yet approved; never link/feature
  last_featured_on TEXT,                               -- YYYY-MM-DD of last featured date
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_product_slot_category ON product_slot(category, active);
CREATE INDEX IF NOT EXISTS idx_product_slot_active ON product_slot(active, approved);

-- System flags: durable key/value switches (e.g. sender_armed timestamp).
-- EMAIL_LIVE is intentionally NOT stored here — it lives in the Pages env
-- so only a dashboard-level change flips the live switch.
CREATE TABLE IF NOT EXISTS system_flag (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO product_slot (slug, name, category, url, angles_json, notes) VALUES
('logitech-c920s', 'Logitech C920s Webcam', 'interview_gear',
 'https://www.amazon.com/dp/B07K986YLL?tag=mehyarus-20',
 '["stop looking like a hostage video on Zoom", "the $70 upgrade hiring managers actually notice", "look like you''re in the room, not in a basement"]',
 'verified ASIN from affiliate content'),
('fifine-k669', 'FIFINE K669 USB Microphone', 'interview_gear',
 'https://www.amazon.com/dp/B01MXL3EOU?tag=mehyarus-20',
 '["sound like you''re in the room", "the $35 fix for laptop-mic interviews", "what they hear is what they judge"]',
 'verified ASIN from affiliate content'),
('screenbar', 'Monitor Light Bar', 'desk_setup',
 'https://www.amazon.com/dp/B076VNFZJG?tag=mehyarus-20',
 '["your desk called, it wants an upgrade", "late-night applications without eye strain", "the setup that photographs well on LinkedIn"]',
 'verified ASIN from affiliate content'),
('mx-master', 'Logitech MX Master Mouse', 'desk_setup',
 'https://www.amazon.com/dp/B0B11LJ69K?tag=mehyarus-20',
 '["apply to 50 jobs without wrist pain", "the mouse every recruiter seems to own", "scroll less, apply more"]',
 'web-verified ASIN 2026-09-13'),
('ember-mug', 'Ember Temperature Control Mug', 'desk_setup',
 'https://www.amazon.com/dp/B0H2BHDDSV?tag=mehyarus-20',
 '["coffee stays hot through long applications", "small luxury for the job hunt grind", "your desk setup''s finishing touch"]',
 'web-verified ASIN 2026-09-13');

-- ASIN pending: URL NULL, inactive until verified.
INSERT OR IGNORE INTO product_slot (slug, name, category, url, angles_json, active, notes) VALUES
('ring-light', '10" Ring Light for video calls', 'interview_gear', NULL,
 '["never interview in the dark again", "the $25 lighting trick streamers use", "look awake on 8am calls"]',
 0,
 'ASIN lookup pending — verify via shopping skill before activating'),
('parachute-book', 'What Color Is Your Parachute? (book)', 'books', NULL,
 '["the career book that''s survived 50 years for a reason", "read this before your next pivot", "figure out what you actually want"]',
 0,
 'ASIN lookup pending — verify via shopping skill before activating');

-- UNAPPROVED affiliate programs: approved=0 AND active=0. Never feature,
-- never link until the program application is accepted.
INSERT OR IGNORE INTO product_slot (slug, name, category, url, angles_json, active, approved, notes) VALUES
('yotru', 'Yotru AI Resume Builder', 'resume',
 'https://yotru.com/affiliate',
 '["resumes that beat the ATS robots", "build a resume in 10 minutes, not 10 hours", "AI that writes what recruiters skim for"]',
 0, 0,
 'UNAPPROVED affiliate program — activate after acceptance'),
('jobtestprep', 'JobTestPrep', 'interview_prep',
 'https://www.jobtestprep.com/affiliates',
 '["practice the test before the test", "assessment day without the panic", "the prep site hiring managers know"]',
 0, 0,
 'UNAPPROVED — activate after acceptance');
