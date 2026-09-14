-- 0020_email_send_meta.sql
-- Genius Flow skeleton tracking: meta_json on the send log so the
-- campaign report and product attribution can read meta_json.product
-- (product slug woven into that send) and meta_json.skeleton. The
-- write path must match what campaignReport.js reads from
-- email_event.meta_json.product -- recordEmailEvent copies the tag
-- from the latest product-woven send onto each engagement event.
ALTER TABLE email_send ADD COLUMN meta_json TEXT NOT NULL DEFAULT '{}';
