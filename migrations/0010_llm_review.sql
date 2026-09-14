-- 0010_llm_review.sql
-- Stores the LLM resume-review result on the user's resume row so it can be
-- shown on the /review page without re-running inference every visit.

ALTER TABLE user_resume ADD COLUMN llm_review_json TEXT;
