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
