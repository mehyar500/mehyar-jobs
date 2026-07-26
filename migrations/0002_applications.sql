-- 0002_applications.sql
-- Application tracking: per (user, job) record. One row per job you
-- decide to pursue, with draft state + submitted state + audit trail.
--
-- Workflow:
--   1. User clicks "Apply" on a job card → POST /api/admin/applications
--      creates a row with status="draft" + a generated cover_letter +
--      a JSON map of custom_answers. Server returns the draft.
--   2. User reviews the draft in the Applications tab. They can edit
--      cover_letter + each custom answer in place (PATCH).
--   3. User clicks "Submit" → POST /api/admin/applications/{id}/submit
--      → status="submitting" → server tries the actual ATS submit
--      endpoint (if available) or just opens the URL in a mailto/onclick
--      + records the submission + sends an email notification.
--   4. status moves to "submitted" or "failed".
--
-- For ATSs without a public submit API (most of them, actually), the
-- "submit" step records the canonical ATS URL the user should visit and
-- sends the email; the user opens the link in a new tab and uses the
-- already-prepared cover letter + answers to fill in the form.
--
-- The email notification is the user's confirmation that the application
-- was logged. It also includes a deep link to update the status manually
-- if the actual ATS submit happens outside the app.

CREATE TABLE IF NOT EXISTS application (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id             INTEGER NOT NULL REFERENCES job(id) ON DELETE CASCADE,
  status             TEXT    NOT NULL DEFAULT 'draft', -- draft|submitting|submitted|failed|withdrawn
  cover_letter       TEXT,                            -- the prepared cover letter text
  custom_answers     TEXT    NOT NULL DEFAULT '{}',   -- JSON map {question: answer}
  resume_snapshot    TEXT,                            -- the resume text used
  submission_method  TEXT,                            -- "ats_api"|"external_link"|"email"|"manual"
  submission_url     TEXT,                            -- canonical URL to actually submit (if external_link)
  ats_response       TEXT,                            -- JSON of the ATS API response (if any)
  notes              TEXT,                            -- free-form user notes
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  submitted_at       TEXT,
  email_sent_at      TEXT,
  email_id           TEXT,                            -- CF email service message id
  UNIQUE(job_id)                                       -- one application per job (latest wins on resubmit)
);

CREATE INDEX IF NOT EXISTS idx_application_job_id       ON application(job_id);
CREATE INDEX IF NOT EXISTS idx_application_status       ON application(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_application_created      ON application(created_at DESC);

-- Per-application event audit (status transitions, edits, etc.)
CREATE TABLE IF NOT EXISTS application_event (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id     INTEGER NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  kind               TEXT    NOT NULL,                -- "created"|"updated"|"submitted"|"submitted_ok"|"submitted_failed"|"email_sent"|"email_failed"|"withdrawn"
  detail             TEXT,                            -- free text
  created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_app_event_app ON application_event(application_id, created_at DESC);
