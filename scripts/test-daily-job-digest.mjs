import assert from "node:assert/strict";
import { buildDailyJobsDigest, digestDisposition } from "../functions/_shared/dailyJobsDigest.js";
import { classifyEmailFailure, deliverDailyDigest } from "../scanner-worker/src/dailyDigest.js";
import { shouldDeactivateMissingContractJobs, syncContractJobs } from "../functions/_shared/scan.js";
import { contractSourceReady, ensureDailySources, nextScanStartJobId, scanDayToRun, sourceFailureDisposition } from "../scanner-worker/src/index.js";

const fixtureJobs = Array.from({ length: 110 }, (_, index) => ({
  id: index + 1,
  title: index === 0 ? `Principal <AI> "Engineer" & Builder` : index === 109 ? "LOW_RANK_ONLY_IN_CSV" : `Engineer ${index + 1}`,
  company_name: index === 0 ? "R&D <Labs>" : `Company ${index + 1}`,
  url: index === 1 ? "javascript:alert(1)" : `https://example.com/jobs/${index + 1}`,
  location: index === 0 ? "New York, NY" : "Remote",
  remote_policy: index % 2 === 0 ? "remote" : "hybrid",
  employment_type: index % 5 === 0 ? "contract" : "full_time",
  salary_min: 120000 + index,
  salary_max: 160000 + index,
  salary_currency: "USD",
  posted_at: `2026-08-24T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
  first_seen_at: "2026-08-24 12:00:00",
  score: index === 109 ? 1 : 100 - (index % 60),
  hard_no: index === 2 ? 1 : 0,
  hard_no_reason: index === 2 ? "clearance" : null,
}));
fixtureJobs[3].title = '=HYPERLINK("https://bad.example","click")';
fixtureJobs[4].company_name = "Comma, Quote \" Corp\nSecond line";

const digest = buildDailyJobsDigest(fixtureJobs, {
  scanDay: "2026-08-24",
  appUrl: "https://jobs.mehyar.us",
  scanStats: { attempted: 129, succeeded: 127, failed: 2, sourceSyncError: "one query failed" },
});

assert.equal(digest.counts.total, 110);
assert.equal(digest.counts.contract, fixtureJobs.filter((job) => job.employment_type === "contract").length);
assert.equal(digest.counts.highFit, fixtureJobs.filter((job) => !job.hard_no && job.score >= 70).length);
assert.equal(digest.attachment.content, digest.csv, "attachment must use raw CSV content, not base64");
assert.equal(digest.attachment.filename, "mehyar-jobs-2026-08-24.csv");
assert.match(digest.subject, /110 new jobs/);
assert.match(digest.text, /attached CSV contains all 110 new jobs/i);
assert.ok(!digest.html.includes("LOW_RANK_ONLY_IN_CSV"), "low-ranked full-time job should stay out of the bounded email body");
assert.ok(digest.csv.includes("LOW_RANK_ONLY_IN_CSV"), "every job must remain in the CSV");
for (const job of fixtureJobs) assert.ok(digest.csv.includes(job.url), `CSV missing job URL ${job.id}`);
assert.ok(!digest.html.includes("javascript:alert(1)"), "unsafe links must not be rendered in HTML");
assert.ok(!digest.html.includes("<AI>"), "scraped HTML must be escaped");
assert.ok(digest.html.includes("&lt;AI&gt;"));
assert.ok(digest.csv.includes(`"'=HYPERLINK(""https://bad.example"",""click"")"`), "spreadsheet formulas must be neutralized");
assert.ok(digest.csv.includes(`"Comma, Quote "" Corp\nSecond line"`), "CSV must quote commas, quotes, and newlines");
assert.match(digest.text, /2 company sources could not be refreshed/);
assert.match(digest.text, /Contract-source warning/);

const degradedDigest = buildDailyJobsDigest(fixtureJobs.slice(0, 1), {
  scanDay: "2026-08-24",
  scanStats: { sourceSyncError: "contract_source_degraded:contract_source_unavailable" },
});
assert.match(degradedDigest.text, /IMPORTANT — Contract feed unavailable/);
assert.match(degradedDigest.text, /Automatic retries will continue/);

const empty = buildDailyJobsDigest([], { scanDay: "2026-08-25", appUrl: "https://jobs.mehyar.us" });
assert.equal(empty.counts.total, 0);
assert.match(empty.subject, /0 new jobs/);
assert.equal(empty.csv.split("\r\n").filter(Boolean).length, 1, "zero-job CSV should contain only its header");

const noSalary = buildDailyJobsDigest([{ ...fixtureJobs[0], salary_min: null, salary_max: null }], { scanDay: "2026-08-24" });
assert.ok(!noSalary.text.includes("$0"), "missing salary data must not render as zero dollars");
assert.ok(!noSalary.html.includes("$0"), "missing salary data must not render as zero dollars");

assert.equal(digestDisposition(null), "missing");
assert.equal(digestDisposition({ email_status: "pending", scan_completed_at: null, email_attempts: 0 }), "scan_incomplete");
assert.equal(digestDisposition({ email_status: "sent", scan_completed_at: "2026-08-24 10:00:00", email_attempts: 1 }), "sent");
assert.equal(digestDisposition({ email_status: "dead_letter", scan_completed_at: "2026-08-24 10:00:00", email_attempts: 1 }), "dead_letter");
assert.equal(digestDisposition({ email_status: "failed", scan_completed_at: "2026-08-24 10:00:00", email_attempts: 12, email_next_attempt_at: "2026-08-25 01:00:00" }), "retry_wait");
assert.deepEqual(classifyEmailFailure(Object.assign(new Error("rate limited"), { code: "E_RATE_LIMIT_EXCEEDED" }), 2), { status: "failed", code: "E_RATE_LIMIT_EXCEEDED", retryModifier: "+30 minutes" });
assert.deepEqual(classifyEmailFailure(Object.assign(new Error("bad sender"), { code: "E_SENDER_NOT_VERIFIED" }), 1), { status: "dead_letter", code: "E_SENDER_NOT_VERIFIED", retryModifier: null });
assert.equal(contractSourceReady({ ok: false, found: 0, errors: [{ query: "backend engineer" }] }), false, "a total contract-feed outage must initially block completion and retry");
assert.equal(contractSourceReady({ ok: true, found: 12, errors: [{ query: "one partial failure" }] }), true, "partial contract results may proceed with a warning");
assert.equal(contractSourceReady({ ok: true, found: 0, errors: [] }), false, "an all-empty fulfilled contract refresh must be treated as suspicious");
assert.equal(shouldDeactivateMissingContractJobs(0, 0), false, "an all-empty refresh must preserve previously active contract rows");
assert.equal(shouldDeactivateMissingContractJobs(10, 1), false, "a partial refresh must preserve rows missing from failed queries");
assert.equal(shouldDeactivateMissingContractJobs(10, 0), true, "only a non-empty complete refresh may deactivate missing rows");
assert.equal(sourceFailureDisposition(0), "failed");
assert.equal(sourceFailureDisposition(1), "failed");
assert.equal(sourceFailureDisposition(2), "degraded", "three failures must stop blocking the daily company scan");
assert.equal(sourceFailureDisposition(9, "degraded"), "degraded", "background contract retries must never re-block a daily scan");
assert.equal(nextScanStartJobId(100, 105), 100, "manual inserts after the previous digest must remain inside the next watermark range");
assert.equal(nextScanStartJobId(null, 105), 105, "a fresh install should start at the current high-water mark");
assert.equal(scanDayToRun({ scan_day: "2026-08-24", completed_at: null }, "2026-08-25"), "2026-08-24", "an incomplete scan must carry across UTC rollover");
assert.equal(scanDayToRun({ scan_day: "2026-08-24", completed_at: "2026-08-24 23:59:00" }, "2026-08-25"), "2026-08-25");

await testContractRefreshPreservation();
await testBoundedSourceRetries();

const acceptedPayloads = [];
const successDb = createDigestDb(fixtureJobs.slice(0, 3));
const successEnv = {
  JOBS_DB: successDb,
  DIGEST_TO_EMAIL: "mrswelim@gmail.com",
  DIGEST_FROM_EMAIL: "noreply@mehyar.us",
  DIGEST_REPLY_TO: "info@mehyar.us",
  JOBS_APP_URL: "https://jobs.mehyar.us",
  EMAIL: {
    async send(payload) {
      acceptedPayloads.push(payload);
      return { messageId: "message-test-123" };
    },
  },
};
const sent = await deliverDailyDigest(successEnv, "2026-08-24");
assert.equal(sent.sent, true);
assert.equal(successDb.row.email_status, "sent");
assert.equal(successDb.row.email_message_id, "message-test-123");
assert.equal(acceptedPayloads.length, 1);
assert.equal(acceptedPayloads[0].to, "mrswelim@gmail.com");
assert.deepEqual(acceptedPayloads[0].from, { email: "noreply@mehyar.us", name: "mehyar.jobs" });
assert.ok(acceptedPayloads[0].text && acceptedPayloads[0].html);
assert.equal(acceptedPayloads[0].attachments[0].content, buildDailyJobsDigest(fixtureJobs.slice(0, 3), { scanDay: "2026-08-24" }).csv);

const duplicate = await deliverDailyDigest(successEnv, "2026-08-24");
assert.equal(duplicate.skipped, true);
assert.equal(duplicate.reason, "sent");
assert.equal(acceptedPayloads.length, 1, "sent digest must not send twice");

const retryDb = createDigestDb(fixtureJobs.slice(0, 1));
let shouldFail = true;
const retryEnv = {
  ...successEnv,
  JOBS_DB: retryDb,
  EMAIL: {
    async send() {
      if (shouldFail) throw new Error("temporary_email_failure");
      return { messageId: "message-retry-456" };
    },
  },
};
const failed = await deliverDailyDigest(retryEnv, "2026-08-24");
assert.equal(failed.sent, false);
assert.equal(retryDb.row.email_status, "failed");
shouldFail = false;
const retried = await deliverDailyDigest(retryEnv, "2026-08-24");
assert.equal(retried.sent, true);
assert.equal(retryDb.row.email_attempts, 2);

const incompleteDb = createDigestDb([], { scan_completed_at: null });
const incomplete = await deliverDailyDigest({ ...successEnv, JOBS_DB: incompleteDb }, "2026-08-24");
assert.equal(incomplete.skipped, true);
assert.equal(incomplete.reason, "scan_incomplete");

const missingBindingDb = createDigestDb(fixtureJobs.slice(0, 1));
const missingBinding = await deliverDailyDigest({ ...successEnv, JOBS_DB: missingBindingDb, EMAIL: undefined }, "2026-08-24");
assert.equal(missingBinding.sent, false);
assert.equal(missingBindingDb.row.email_status, "dead_letter", "a missing binding must never mark the digest sent");
assert.match(missingBindingDb.row.email_last_error, /EMAIL binding missing/);

console.log("daily job digest tests passed");

async function testContractRefreshPreservation() {
  const emptyDb = createContractDb();
  const emptyResult = await syncContractJobs({ JOBS_DB: emptyDb }, {
    queries: ["backend", "platform"],
    profile: {},
    fetchContracts: async () => [],
  });
  assert.equal(emptyResult.ok, false);
  assert.equal(emptyResult.suspicious_empty, true);
  assert.equal(emptyResult.removed, 0);
  assert.equal(emptyDb.deactivationCount, 0, "an all-empty provider response must not deactivate prior contract rows");

  const partialDb = createContractDb();
  const partialResult = await syncContractJobs({ JOBS_DB: partialDb }, {
    queries: ["working", "failing"],
    profile: {},
    fetchContracts: async (query) => {
      if (query === "failing") throw new Error("provider unavailable");
      return [{
        guid: "contract-1",
        title: "Contract Platform Engineer",
        companyName: "Example Co",
        companySlug: "example-co",
        applicationLink: "https://example.com/contract-1",
        locationRestrictions: ["United States"],
        parentCategories: ["Engineering"],
        description: "Six-month contract at $90/hour",
        pubDate: 1787616000,
      }];
    },
  });
  assert.equal(partialResult.ok, true);
  assert.equal(partialResult.found, 1);
  assert.equal(partialResult.errors.length, 1);
  assert.equal(partialResult.removed, 0);
  assert.equal(partialDb.deactivationCount, 0, "a partial provider response must preserve rows owned by the failed query");
}

async function testBoundedSourceRetries() {
  const db = createSourceStateDb();
  const env = { JOBS_DB: db };
  const unavailable = {
    syncSeedCompanies: async () => 129,
    syncContractJobs: async () => ({ ok: false, found: 0, suspicious_empty: true, errors: [] }),
  };

  const first = await ensureDailySources(env, db.row.scan_day, unavailable);
  assert.equal(first.ready, false);
  assert.equal(db.row.source_sync_status, "failed");
  assert.equal(db.row.source_sync_attempts, 1);

  const second = await ensureDailySources(env, db.row.scan_day, unavailable);
  assert.equal(second.ready, false);
  assert.equal(db.row.source_sync_status, "failed");
  assert.equal(db.row.source_sync_attempts, 2);

  const third = await ensureDailySources(env, db.row.scan_day, unavailable);
  assert.equal(third.ready, true, "attempt three must allow the company scan to continue");
  assert.equal(third.degraded, true);
  assert.equal(db.row.source_sync_status, "degraded");
  assert.match(db.row.source_sync_error, /contract_source_degraded/);

  const backgroundRetry = await ensureDailySources(env, db.row.scan_day, unavailable);
  assert.equal(backgroundRetry.ready, true, "a degraded background retry must never re-block the daily scan");
  assert.equal(db.row.source_sync_status, "degraded");
}

function createContractDb() {
  const db = {
    deactivationCount: 0,
    prepare(sql) {
      let binds = [];
      const statement = {
        bind(...values) {
          binds = values;
          return statement;
        },
        async first() {
          if (sql.includes("SELECT id FROM company WHERE slug")) return { id: 1 };
          if (sql.includes("SELECT id FROM job WHERE company_id")) return null;
          return null;
        },
        async all() {
          if (sql.includes("FROM job j JOIN company c")) return { results: [] };
          return { results: [] };
        },
        async run() {
          void binds;
          if (sql.includes("UPDATE job SET is_active = 0 WHERE source_kind = 'himalayas'")) db.deactivationCount += 1;
          return { meta: { changes: 0 } };
        },
      };
      return statement;
    },
  };
  return db;
}

function createSourceStateDb() {
  const row = {
    scan_day: "2026-08-24",
    source_sync_status: "pending",
    source_sync_attempts: 0,
    source_sync_claimed_at: null,
    source_sync_completed_at: null,
    source_sync_error: null,
  };
  const db = {
    row,
    prepare(sql) {
      let binds = [];
      const statement = {
        bind(...values) {
          binds = values;
          return statement;
        },
        async first() {
          if (sql.includes("SELECT * FROM daily_job_digest")) return { ...row };
          return null;
        },
        async run() {
          if (sql.includes("SET source_sync_status = 'running'")) {
            row.source_sync_status = "running";
            row.source_sync_attempts += 1;
            row.source_sync_claimed_at = "2026-08-24 12:00:00";
            return { meta: { changes: 1 } };
          }
          if (sql.includes("SET source_sync_status = ?")) {
            row.source_sync_status = binds[0];
            row.source_sync_error = binds[2];
            if (binds[0] === "degraded") row.source_sync_completed_at = "2026-08-24 12:00:00";
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
    async batch(statements) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
  return db;
}

function createDigestDb(jobs, overrides = {}) {
  const row = {
    scan_day: "2026-08-24",
    selection_mode: "watermark",
    scan_started_at: "2026-08-24 00:00:00",
    start_job_id: 0,
    scan_completed_at: "2026-08-24 10:00:00",
    end_job_id: Math.max(0, ...jobs.map((job) => Number(job.id))),
    source_sync_error: null,
    email_status: "pending",
    email_attempts: 0,
    recipient: "mrswelim@gmail.com",
    ...overrides,
  };

  const db = {
    row,
    prepare(sql) {
      let binds = [];
      const statement = {
        bind(...values) {
          binds = values;
          return statement;
        },
        async first() {
          if (sql.includes("FROM daily_job_digest")) return { ...row };
          if (sql.includes("FROM scrape_run")) return { attempted: 3, succeeded: 3, failed: 0 };
          return null;
        },
        async all() {
          if (!sql.includes("FROM job j")) return { results: [] };
          const afterId = Number(binds[0] || 0);
          const endId = Number(binds[1] || row.end_job_id);
          const limit = Number(binds[2] || 500);
          return { results: jobs.filter((job) => job.id > afterId && job.id <= endId).slice(0, limit) };
        },
        async run() {
          if (sql.includes("SET email_status = 'sending'")) {
            const claimable = row.scan_completed_at && ["pending", "failed"].includes(row.email_status);
            if (!claimable) return { meta: { changes: 0 } };
            row.email_status = "sending";
            row.email_attempts += 1;
            row.email_last_error = null;
            return { meta: { changes: 1 } };
          }
          if (sql.includes("SET job_count = ?")) {
            [row.job_count, row.high_fit_count, row.contract_count, row.remote_count] = binds;
            return { meta: { changes: 1 } };
          }
          if (sql.includes("SET email_status = 'sent'")) {
            row.email_status = "sent";
            row.email_message_id = binds[0];
            return { meta: { changes: 1 } };
          }
          if (sql.includes("email_next_attempt_at = CASE")) {
            row.email_status = binds[0];
            row.email_last_error = binds[1];
            row.email_error_code = binds[2];
            row.email_next_attempt_at = binds[3];
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
  };
  return db;
}
