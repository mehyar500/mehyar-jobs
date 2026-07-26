-- 0003_application_tracking.sql
-- Adds company-side confirmation tracking. The third-party company
-- sends the real "thank you for applying" email; we record when the
-- user marks that email as received.
--
-- Two ways to update company_confirmed_at:
--   1. Manual: user clicks "I got the company's email" on the
--      application detail page after seeing the confirmation in
--      their inbox.
--   2. Auto: user sets up a unique tracking email (app-{id}@jobs.mehyar.us)
--      in the company form instead of their personal one, and we have
--      a Worker that parses incoming mail and updates D1. Wired in
--      a future round; the column + index are here.

ALTER TABLE application ADD COLUMN company_confirmed_at TEXT;
ALTER TABLE application ADD COLUMN company_confirmed_source TEXT;  -- "manual"|"auto_email"
ALTER TABLE application ADD COLUMN company_email_subject TEXT;     -- the subject line the user saw
ALTER TABLE application ADD COLUMN tracking_email TEXT;           -- "app-123@jobs.mehyar.us" (optional, for auto-detect)
ALTER TABLE application ADD COLUMN next_action_at TEXT;            -- "follow up by" reminder
ALTER TABLE application ADD COLUMN follow_up_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_application_submitted      ON application(submitted_at);
CREATE INDEX IF NOT EXISTS idx_application_confirmed      ON application(company_confirmed_at, submitted_at);
CREATE INDEX IF NOT EXISTS idx_application_next_action    ON application(next_action_at);


-- ── Profile: extended fields for browser-based auto-fill ──
-- Stores the resume PDF/DOCX (base64), LinkedIn URL, GitHub URL,
-- portfolio URLs, work samples, plus a default set of form answers
-- (work auth, sponsorship, years of experience, etc.) the LLM
-- uses as ground truth when filling the company form.

ALTER TABLE profile ADD COLUMN resume_filename TEXT;
ALTER TABLE profile ADD COLUMN resume_mime      TEXT;             -- "application/pdf" | "application/msword"
ALTER TABLE profile ADD COLUMN resume_base64    TEXT;             -- the actual file, base64 encoded (<2 MB)
ALTER TABLE profile ADD COLUMN resume_text      TEXT;             -- plaintext version (for form-filling)
ALTER TABLE profile ADD COLUMN linkedin_url     TEXT;
ALTER TABLE profile ADD COLUMN github_url       TEXT;
ALTER TABLE profile ADD COLUMN portfolio_url    TEXT;
ALTER TABLE profile ADD COLUMN personal_website TEXT;
ALTER TABLE profile ADD COLUMN phone            TEXT;
ALTER TABLE profile ADD COLUMN city             TEXT;             -- current location
ALTER TABLE profile ADD COLUMN country          TEXT;
ALTER TABLE profile ADD COLUMN work_auth       TEXT;             -- "US Citizen" | "Green Card" | "Need Sponsorship" | etc.
ALTER TABLE profile ADD COLUMN years_experience INTEGER;
ALTER TABLE profile ADD COLUMN current_title    TEXT;
ALTER TABLE profile ADD COLUMN current_company  TEXT;
ALTER TABLE profile ADD COLUMN current_salary   INTEGER;
ALTER TABLE profile ADD COLUMN notice_period    TEXT;             -- "2 weeks" | "1 month" | "Immediately" etc.
ALTER TABLE profile ADD COLUMN gender           TEXT;
ALTER TABLE profile ADD COLUMN ethnicity         TEXT;
ALTER TABLE profile ADD COLUMN veteran_status   TEXT;
ALTER TABLE profile ADD COLUMN disability       TEXT;             -- voluntary self-identification
ALTER TABLE profile ADD COLUMN hispanic_latino  TEXT;             -- separate from ethnicity
ALTER TABLE profile ADD COLUMN cleartext_address TEXT;             -- for some forms
ALTER TABLE profile ADD COLUMN default_answers_json TEXT NOT NULL DEFAULT '{}';  -- {"how did you hear about us": "LinkedIn", ...}


-- ── Auto-submit runs (CF Browser Rendering sessions) ──
-- One row per headless attempt. Stores the full log, the form
-- fields that were filled, the final URL, whether the "thanks for
-- applying" page was detected, and the final screenshot as base64.

CREATE TABLE IF NOT EXISTS auto_submit_run (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id           INTEGER NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  status                   TEXT    NOT NULL DEFAULT 'running',  -- running|submitted|submitted_unconfirmed|failed
  started_at               TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at              TEXT,
  final_url                TEXT,
  confirmation_detected    INTEGER NOT NULL DEFAULT 0,           -- 1 if "thanks for applying" text seen
  log                      TEXT    NOT NULL DEFAULT '[]',        -- JSON array of {step, at, ...}
  form_filled              TEXT    NOT NULL DEFAULT '{}',        -- JSON {field_name: {value, source}}
  screenshot_base64        TEXT,                                -- base64 PNG of the post-submit page
  error                    TEXT
);

CREATE INDEX IF NOT EXISTS idx_auto_run_app          ON auto_submit_run(application_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_auto_run_status       ON auto_submit_run(status);


-- ── Email inbound log ──
-- Audit trail of every email we receive at info@mehyar.us (or
-- app-{id}@jobs.mehyar.us) via the /api/email/inbound webhook.
-- Even unmatched ones are recorded so we can see what came in.

CREATE TABLE IF NOT EXISTS email_inbound (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at             TEXT    NOT NULL DEFAULT (datetime('now')),
  from_addr               TEXT,
  to_addr                 TEXT,
  subject                 TEXT,
  body_excerpt            TEXT,
  matched_application_id  INTEGER REFERENCES application(id) ON DELETE SET NULL,
  matched_at              TEXT
);

CREATE INDEX IF NOT EXISTS idx_email_inbound_received  ON email_inbound(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_inbound_app      ON email_inbound(matched_application_id);
