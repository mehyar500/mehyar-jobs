-- 0005_profile_identity.sql
-- Required fields for a reviewed application draft. They are intentionally
-- separate from fit-scoring fields and are never used to rank jobs.

ALTER TABLE profile ADD COLUMN full_name TEXT;
ALTER TABLE profile ADD COLUMN email TEXT;
