# Genius Flow — "Mayor Jobs" Email Engine Spec

The Genius Flow is the mehyar.jobs email growth engine: a daily sender that
looks hand-written, converts job seekers into app users and free-check
uploaders, and weaves in one affiliate product per day with honest
disclosure. Template diversity, seductive-but-true copy, one-click
readiness, and daily performance reporting are the four directives.

## 1. Template diversity (6 skeletons)

Different people get structurally different emails on the same day. The
skeleton for a recipient is picked deterministically:

```
skeleton_idx = hashStr(email + "|" + dateStr) % 6
```

Stable per recipient per day (no recipient sees two versions), different
across the list (no bot-blast fingerprint). `hashStr` is the djb2 in
`functions/_shared/emailFunnel.js` — the same primitive that powers the
digest subject rotation.

### Skeleton 0 — hook-local
One local market stat, then the ask. Built for recipients with a known
city/zip. Never assumes a role or industry (we know only email + location).

Structure: `[location stat]` → `[why it matters to them]` → `[one CTA]`

### Skeleton 1 — digest
The existing daily digest (matches table + resume-score block). Structural
anchor of the program; the other five skeletons are the rotation that
keeps it from looking like a machine.

### Skeleton 2 — winback
For at-risk bands only. Short. Gives them the out ("want to stop? one
tap") — a graceful exit beats a spam complaint. Already implemented in
`renderDigestEmail` as the winback variant.

### Skeleton 3 — repermission
For stale/unengaged imports: asks permission plainly, one tap to keep
receiving, one tap to leave. No matches, no sell. One screen on mobile.

### Skeleton 4 — value-only
No CTA to the app at all. One genuinely useful piece of job-search
intelligence (a market stat, a filter trick for the site, a salary-band
reading). The reply ask IS the CTA ("reply and tell me what you're
seeing"). High replies train Gmail's engagement filters better than
anything else we send.

### Skeleton 5 — tool-spotlight
One of our own free tools per email (ATS Mirror, Resume Studio, AI Resume
Review, Job Alerts) — rotating deterministically per recipient per day.
Zero affiliate weave; the tool IS the value. Doubles as the repermission
vehicle for the legacy cohort ("we built this free thing for you"):
legacy pending contacts rotate between skeleton 3 and skeleton 5 only,
regardless of the brain's weight mix.

Structure: `[headline]` → `[what the tool does + why it matters]` → `[one CTA]`

## 2. Subject pool

Target: 20+ subjects, each matching a skeleton. The current 5+2 rotating
subjects in `digestSubject()` are the seed pool; the rest get added as
each skeleton ships. Rules:

- Personal when we have a name; never invent one.
- No FREE, no all-caps words, no exclamation marks.
- Each subject is stable per recipient per day via `hashStr(email|date)`.
- Win-back gets its own 2-subject sub-pool (already implemented).

Target composition: hook-local ×5, digest ×5, winback ×2, repermission ×4,
value-only ×4 = 20.

## 3. Copy rules (hard)

1. **No emojis.** Ever. In any skeleton.
2. **No AI tells.** Never "delve", never "game-changer", never buzzword
   stacks ("leverage cutting-edge synergies"), never em-dash confetti —
   one em dash per email max, and only between two real clauses.
3. **Short sentences. Fragments allowed.** Write like a person typing fast
   on a phone. Paragraphs are 1–3 sentences.
4. **REAL numbers only, and only from our job data.** Salary bands from
   scraped postings, role counts from the DB, remote share computed from
   `job.remote_policy`. If a stat isn't in the DB, it doesn't go in the
   email. Never round up to sound bigger.
5. **Emphasize high demand, high pay, remote — with true stats.**
   "312 backend postings in NYC this week. 41% list remote. Top band
   $165k–$210k." All three claims must be queryable. Template wording
   always cites the window ("this week", "in your area") so it can't
   drift into a standing claim.
6. **One CTA per email.** The CTA is a single link. Everything else is
   text links or nothing.
7. **Reply ask in every send.** "Hit reply and tell me X" — replies are
   the strongest inboxing signal there is.
8. **#ad disclosure on affiliate links.** Any woven product gets
   `#ad` + "affiliate link" wording adjacent to the link, in both HTML
   and text versions.
9. **List-Unsubscribe already built** — every send carries the signed
   one-click unsubscribe (header + footer link). Never ask for the email
   address; we have it.
10. **Never guarantee outcomes.** No "get interviews", no "land the job".
    The promise is information: matches, scores, market data.
11. **No-assumption rule:** the recipient is known only by email + zip/city
    unless they created an account. Never assume their role, seniority,
    industry, or employment status.

## 4. Market-data queries (the only allowed number sources)

- Role counts: `SELECT COUNT(*) FROM job WHERE is_active=1 AND LOWER(title) LIKE ? AND posted_at >= date('now','-7 days')`
- Salary bands: `salary_min/salary_max` percentiles over the same set.
- Remote share: `SUM(remote_policy='remote') / COUNT(*)` over the set.
- City counts: same, filtered by `location LIKE '%<city>%'`.

All numbers are computed at send time (or daily and cached), never
hard-coded in copy.

## 5. Example hook emails (no-assumption rule)

Both examples below assume only: `email`, `city = "Newark"`, `state = "NJ"`.
No role, no name, no seniority. Numbers are illustrative of format — in
production they come from the queries in §4.

### Example A — hook-local skeleton

Subject: `Newark: 214 tech postings this week, 38% remote`

```
Hi,

214 tech postings went up within 25 miles of Newark this week.

38% list remote. The top salary band in the batch: $145k–$185k.

That's the market. Here's what it means for you: the jobs are there.
The filter is the resume.

Run your resume through the free fit check. It scores you against real
postings and tells you exactly what's blocking interviews.

Get your free score: https://jobs.mehyar.us/review

One question back: what's the biggest thing slowing your search right
now? Hit reply. I read every one.

— Mehyar

P.S. Doing video interviews this week? The Logitech C920s is the $70
webcam upgrade hiring managers actually notice. #ad affiliate link:
https://www.amazon.com/dp/B07K986YLL?tag=mehyarus-20

You're getting this because you asked for free job alerts from
mehyar.jobs. Unsubscribe: <one-click link>
```

Why it works: opens with a true local stat, translates it into meaning
in one line, single CTA, reply ask, product woven with disclosure,
unsubscribe in the footer.

### Example B — value-only skeleton

Subject: `the 10-second filter trick for remote roles`

```
Hi,

Quick one. No pitch today.

On mehyar.jobs, filter location to "Remote" and sort by posted date.
Then check the posting age before you apply.

Anything older than 30 days with 500+ applicants is a ghost listing.
Skip it. Your time is worth more than a black hole.

The sweet spot: posted in the last 7 days, under 100 applicants.
That's where the reply rate lives.

Try it: https://jobs.mehyar.us

Reply and tell me what you're seeing out there. Real data beats
guesswork, and I collect both.

— Mehyar

You're getting this because you asked for free job alerts from
mehyar.jobs. Unsubscribe: <one-click link>
```

Why it works: pure value, zero sell, the reply ask is the whole CTA.
This is the skeleton that trains the inbox providers to trust the
domain.

## 6. Wire-up (one-click readiness)

`POST /api/admin/email/wire-up` runs the readiness checklist and, only if
every check passes, stamps `system_flag.sender_armed`. Checks: SMTP2GO API,
Brevo API, Fibonacci gate state, seed-test record for `daily_digest`
(inbox ≥ 80%, spam ≤ 5%), suppression tables, product catalog (≥ 1
active+approved product), recipient cohort (non-empty), and the live
switch (must be OFF — wire-up refuses to arm while live).

The ARM button is the wire-up endpoint. The EMAIL_LIVE flip is NEVER
automated and NEVER part of wire-up — it is Mayor's explicit manual
action in the Pages dashboard.

## 7. Daily campaign report

`GET /api/admin/email/campaign-report?date=YYYY-MM-DD` returns the full
day: sends by status, events by kind, CTR (clicks/sends), open rate
(opens/delivered), per template×variant×subject counts, offer
aggregation from `meta_json.offer`, product of the day + product-tagged
events from `meta_json.product`, landing-page status, the fib gate row,
the armed timestamp, and provider-side SMTP2GO history (fetched
server-side; provider failure still returns the D1 report with
`provider.error`).

The report is the data source for the "Mayor Jobs" tab on
dashboard.mehyar.us. Full detail means: sends, subjects, bodies' counts,
offers, woven products, landing pages, opens, clicks.

## 8. Product catalog (migration 0019)

The woven product comes from `product_slot` (see
`migrations/0018_product_catalog.sql` + `functions/_shared/productCatalog.js`).
One active+approved product is featured per day, rotated across categories
by weekday with a 30-day per-product cooldown. Only `active=1 AND
approved=1` rows are eligible for featuring.

Migration 0019 added a factual `description` column (1–2 sentences each,
no hype, no invented specs/prices) and activated the two remaining ASINs
after verifying them against the live Amazon dp pages (title match +
product-info table):

| slug | product | status | affiliate link |
|---|---|---|---|
| logitech-c920s | Logitech C920s Webcam | active+approved | amazon.com/dp/B07K986YLL |
| fifine-k669 | FIFINE K669 USB Microphone | active+approved | amazon.com/dp/B01MXL3EOU |
| screenbar | Monitor Light Bar | active+approved | amazon.com/dp/B076VNFZJG |
| mx-master | Logitech MX Master Mouse | active+approved | amazon.com/dp/B0B11LJ69K |
| ember-mug | Ember Temperature Control Mug | active+approved | amazon.com/dp/B0H2BHDDSV |
| ring-light | NEEWER Basics 10" Ring Light | active+approved | amazon.com/dp/B0FLJV1BVB |
| parachute-book | What Color Is Your Parachute? (latest paperback) | active+approved | amazon.com/dp/1984861204 |
| yotru | Yotru AI Resume Builder | active=0, approved=0 | — (program unapproved) |
| jobtestprep | JobTestPrep | active=0, approved=0 | — (program unapproved) |

Notes:
- `image_url` stays NULL for all 9 — no affiliate imagery exists in the
  repo and Amazon CDN image URLs are not stable/guessable. It gets filled
  only from a verified source, never invented.
- The book link is the current in-print revised paperback (ISBN-13
  978-1984861207); no 2026-edition ASIN could be confirmed from
  publisher/retailer sources as of 2026-09-13.
- yotru/jobtestprep stay excluded from rotation, links, and featuring
  until their affiliate programs are approved. Never set them active
  without an approval signal.
