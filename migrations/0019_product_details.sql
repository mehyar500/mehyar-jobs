-- 0019_product_details.sql
-- Worker 1 (product enrichment), Genius Flow email engine.
--
-- Adds a factual 'description' column to product_slot, fills
-- descriptions for all 9 products, and activates the two ASINs verified
-- by opening the live Amazon dp pages (title match + product-info table):
--
--   B0FLJV1BVB  -> "NEEWER Basics 10" Selfie Ring Light with Tripod
--                   Stand/3 Phone Holders..." (ASIN confirmed in the page's
--                   product-information table)
--   1984861204  -> "What Color Is Your Parachute?: Your Guide to a Lifetime
--                   of Meaningful Work and Career Success" by Richard N.
--                   Bolles (ISBN-10 1984861204, ISBN-13 978-1984861207,
--                   Ten Speed Press, revised edition)
--
-- No 2026-edition ASIN could be confirmed from publisher/retailer sources,
-- so the book link points at the current in-print revised paperback above.
--
-- yotru / jobtestprep STAY approved=0 AND active=0 — their affiliate
-- programs are unapproved; they must not be featured or linked.
--
-- image_url left NULL for all products: there is no affiliate imagery in
-- this repo and Amazon CDN image URLs are not stable/guessable. Never
-- guess image URLs; populate image_url only from a verified source.

-- "only if missing": SQLite has no IF NOT EXISTS for ADD COLUMN, but the
-- migration runner records each migration in __migrations and never
-- re-applies it; the statement runner also ignores re-run errors.
ALTER TABLE product_slot ADD COLUMN description TEXT;

-- ── descriptions (factual, 1-2 sentences; no hype, no prices) ────────
UPDATE product_slot SET description =
 'A 1080p webcam with autofocus, dual microphones, and a built-in privacy shutter, made for video calls.'
WHERE slug = 'logitech-c920s';

UPDATE product_slot SET description =
 'A plug-and-play USB condenser microphone on a tripod stand, built for clearer voice on calls and recordings.'
WHERE slug = 'fifine-k669';

UPDATE product_slot SET description =
 'A light bar that mounts on top of a monitor to light the desk evenly without taking up space.'
WHERE slug = 'screenbar';

UPDATE product_slot SET description =
 'An ergonomic wireless mouse with a precision scroll wheel, built for long days of clicking.'
WHERE slug = 'mx-master';

UPDATE product_slot SET description =
 'A rechargeable mug that holds drinks at a chosen temperature via its companion app.'
WHERE slug = 'ember-mug';

UPDATE product_slot SET description =
 'A 10-inch LED ring light with tripod stand and phone holders: USB powered, with 3 color modes and 10 brightness levels.'
WHERE slug = 'ring-light';

UPDATE product_slot SET description =
 'Richard N. Bolles''s long-running career guide on job hunting and career change, covering networking, resumes, interviewing, and finding meaningful work.'
WHERE slug = 'parachute-book';

UPDATE product_slot SET description =
 'An AI-assisted resume builder for job seekers. Affiliate program not yet approved — do not link or feature.'
WHERE slug = 'yotru';

UPDATE product_slot SET description =
 'Practice tests for pre-employment assessments and aptitude tests. Affiliate program not yet approved — do not link or feature.'
WHERE slug = 'jobtestprep';

-- ── activate the two verified ASINs ─────────────────────────────────
UPDATE product_slot SET
  name = 'NEEWER Basics 10" Ring Light',
  url = 'https://www.amazon.com/dp/B0FLJV1BVB?tag=mehyarus-20',
  active = 1,
  approved = 1,
  notes = 'ASIN verified 2026-09-13: dp page title + product-info table match'
WHERE slug = 'ring-light';

UPDATE product_slot SET
  name = 'What Color Is Your Parachute?: Your Guide to a Lifetime of Meaningful Work and Career Success',
  url = 'https://www.amazon.com/dp/1984861204?tag=mehyarus-20',
  active = 1,
  approved = 1,
  notes = 'ASIN verified 2026-09-13: dp page title + ISBN match (ISBN-13 978-1984861207); current in-print revised paperback — no 2026-edition ASIN confirmed'
WHERE slug = 'parachute-book';
