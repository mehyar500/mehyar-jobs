-- 0021_campaign_plan.sql
-- Campaign brain plans: one LLM-written plan row per day for the Genius
-- Flow email engine ("Mayor Jobs").
--
-- The brain (scanner worker, 06:30 ET cron) WRITES exactly one row per
-- date: the day's template mix, product-of-day override, subject tweaks,
-- and segment focus, plus a plain-English reasoning summary. The daily
-- sender READS the row and follows it; with no row it falls back to the
-- existing deterministic behavior.
--
-- HARD RULE: this table never triggers sends and never touches EMAIL_LIVE.

CREATE TABLE IF NOT EXISTS campaign_plan (
  plan_date      TEXT PRIMARY KEY,  -- YYYY-MM-DD
  plan_json      TEXT NOT NULL,     -- validated plan (skeleton mix, product, subjects, segment focus)
  reasoning_text TEXT NOT NULL,     -- plain-English 2-4 sentence summary from the LLM
  model          TEXT NOT NULL,     -- Workers AI model ("...:deterministic-fallback" when the LLM failed)
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
