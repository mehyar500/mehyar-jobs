import { ensureSchema } from "../../functions/_shared/db.js";
import { scanCompanyBatch, syncContractJobs, syncSeedCompanies } from "../../functions/_shared/scan.js";
import { deliverOldestCompletedDigest, ensureLegacyDigestForCompletedState } from "./dailyDigest.js";

const STATE_NAME = "daily-company-scan";
const SOURCE_CLAIM_STALE_MINUTES = 30;
const SOURCE_RETRY_MINUTES = 15;
const MAX_BLOCKING_SOURCE_ATTEMPTS = 3;
const DEGRADED_SOURCE_RETRY_HOURS = 6;

export default {
  async scheduled(controller, env) {
    await runScheduledBatch(env, controller.cron || "cron");
  },

  async fetch(request, env) {
    if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
    await ensureSchema(env);
    const stateRow = await env.JOBS_DB.prepare("SELECT * FROM scan_scheduler_state WHERE name = ?").bind(STATE_NAME).first();
    const state = stateRow ? {
      name: stateRow.name,
      scan_day: stateRow.scan_day,
      cursor: stateRow.cursor,
      completed_at: stateRow.completed_at,
      has_error: Boolean(stateRow.last_error),
      updated_at: stateRow.updated_at,
    } : null;
    const latestDigest = await env.JOBS_DB.prepare(`
      SELECT scan_day, scan_started_at, scan_completed_at, source_sync_status,
             CASE WHEN source_sync_error IS NULL THEN 0 ELSE 1 END AS source_warning,
             email_status, email_attempts, email_sent_at, email_next_attempt_at,
             CASE WHEN email_last_error IS NULL THEN 0 ELSE 1 END AS email_has_error,
             job_count, high_fit_count, contract_count, remote_count, updated_at
      FROM daily_job_digest
      ORDER BY scan_day DESC
      LIMIT 1
    `).first();
    return json({ ok: true, service: "mehyar-jobs-scanner", state, daily_digest: latestDigest, ts: new Date().toISOString() });
  },
};

export async function runScheduledBatch(env, cron = "cron") {
  await ensureSchema(env);
  const db = env.JOBS_DB;
  const today = new Date().toISOString().slice(0, 10);
  const recipient = env.DIGEST_TO_EMAIL || "mrswelim@gmail.com";
  let state = await loadState(db);

  // Backfill one outbox row for a scan completed before digest delivery was
  // introduced. This lets the first deployment send today's completed scan.
  if (state?.completed_at) await ensureLegacyDigestForCompletedState(db, state, recipient);

  // Process yesterday's unsent digest before starting a new day. Failures stay
  // in the D1 outbox and retry on later cron invocations without rescanning.
  let delivery = await deliverOldestCompletedDigest(env);

  if (state?.scan_day === today && state.completed_at) {
    // A degraded contract source is retried independently after the daily
    // company scan/email has been allowed to finish. This improves tomorrow's
    // watermark without making a third-party outage stop daily delivery.
    const sourceSync = await ensureDailySources(env, today);
    console.log(JSON.stringify({ event: "daily_scan_already_complete", day: today, completed_at: state.completed_at, source_sync: sourceSync, delivery }));
    return { ok: true, skipped: true, reason: "already_complete", day: today, source_sync: sourceSync, delivery };
  }

  // Never overwrite an unfinished cursor at UTC rollover. Complete and email
  // that scan first; the next cron invocation will initialize the new day.
  if (!state || state.completed_at) {
    await initializeDailyScan(db, today, recipient);
    state = await loadState(db);
  }
  const day = scanDayToRun(state, today);
  const carriedOver = day !== today;

  const sourceSync = await ensureDailySources(env, day);
  if (!sourceSync.ready) {
    return { ok: false, skipped: true, reason: sourceSync.reason, day, source_sync: sourceSync, delivery };
  }

  state = await loadState(db);
  if (state?.completed_at) {
    delivery = await deliverOldestCompletedDigest(env);
    return { ok: true, skipped: true, reason: "already_complete", day, delivery };
  }

  try {
    const batch = await scanCompanyBatch(env, { afterId: state?.cursor || 0, limit: 3, trigger: `scheduled:${cron}` });
    if (batch.done) {
      const completedAt = sqliteNow();
      const bound = await db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM job").first();
      await db.batch([
        db.prepare(`
          UPDATE scan_scheduler_state
          SET cursor = ?, completed_at = ?, last_error = NULL, updated_at = datetime('now')
          WHERE name = ? AND scan_day = ?
        `).bind(batch.cursor || 0, completedAt, STATE_NAME, day),
        db.prepare(`
          UPDATE daily_job_digest
          SET scan_completed_at = ?, end_job_id = ?, updated_at = datetime('now')
          WHERE scan_day = ?
        `).bind(completedAt, Number(bound?.id || 0), day),
      ]);
      delivery = await deliverOldestCompletedDigest(env);
    } else {
      await db.prepare(`
        UPDATE scan_scheduler_state
        SET cursor = ?, last_error = NULL, updated_at = datetime('now')
        WHERE name = ? AND scan_day = ?
      `).bind(batch.cursor || 0, STATE_NAME, day).run();
    }
    const outcome = { ...batch, day, today, carried_over: carriedOver, source_sync: sourceSync, delivery };
    console.log(JSON.stringify({ event: "daily_scan_batch", ...outcome }));
    return outcome;
  } catch (error) {
    const message = String(error?.message || error).slice(0, 1000);
    await db.prepare("UPDATE scan_scheduler_state SET last_error = ?, updated_at = datetime('now') WHERE name = ?")
      .bind(message, STATE_NAME).run();
    console.error(JSON.stringify({ event: "daily_scan_failed", day, cursor: state?.cursor || 0, error: message }));
    throw error;
  }
}

async function initializeDailyScan(db, day, recipient) {
  const now = sqliteNow();
  const bound = await db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM job").first();
  const previous = await db.prepare(`
    SELECT end_job_id
    FROM daily_job_digest
    WHERE scan_completed_at IS NOT NULL AND end_job_id IS NOT NULL
    ORDER BY scan_day DESC
    LIMIT 1
  `).first();
  const startJobId = nextScanStartJobId(previous?.end_job_id, bound?.id);
  await db.batch([
    db.prepare(`
      INSERT OR IGNORE INTO daily_job_digest (
        scan_day, selection_mode, scan_started_at, start_job_id,
        source_sync_status, email_status, recipient, updated_at
      ) VALUES (?, 'watermark', ?, ?, 'pending', 'pending', ?, datetime('now'))
    `).bind(day, now, startJobId, recipient),
    db.prepare(`
      INSERT INTO scan_scheduler_state (name, scan_day, cursor, completed_at, last_error, updated_at)
      VALUES (?, ?, 0, NULL, NULL, datetime('now'))
      ON CONFLICT(name) DO UPDATE SET
        scan_day = excluded.scan_day,
        cursor = 0,
        completed_at = NULL,
        last_error = NULL,
        updated_at = datetime('now')
      WHERE scan_scheduler_state.scan_day <> excluded.scan_day
    `).bind(STATE_NAME, day),
  ]);
  console.log(JSON.stringify({ event: "daily_scan_initialized", day, start_job_id: startJobId }));
}

export async function ensureDailySources(env, day, services = {}) {
  const db = env.JOBS_DB;
  const seedCompanies = services.syncSeedCompanies || syncSeedCompanies;
  const syncContracts = services.syncContractJobs || syncContractJobs;
  const row = await db.prepare("SELECT * FROM daily_job_digest WHERE scan_day = ?").bind(day).first();
  if (!row) return { ready: false, reason: "digest_state_missing" };
  if (row.source_sync_status === "complete") {
    return { ready: true, skipped: true, warning: row.source_sync_error || null };
  }

  const claim = await db.prepare(`
    UPDATE daily_job_digest
    SET source_sync_status = 'running',
        source_sync_attempts = source_sync_attempts + 1,
        source_sync_claimed_at = datetime('now'),
        source_sync_error = CASE WHEN source_sync_status = 'degraded' THEN source_sync_error ELSE NULL END,
        updated_at = datetime('now')
    WHERE scan_day = ?
      AND (
        source_sync_status IN ('pending', 'failed')
        OR (source_sync_status = 'running' AND source_sync_claimed_at < datetime('now', ?))
        OR (source_sync_status = 'degraded' AND source_sync_claimed_at < datetime('now', ?))
      )
      AND (
        source_sync_status <> 'failed'
        OR source_sync_claimed_at IS NULL
        OR source_sync_claimed_at <= datetime('now', ?)
      )
  `).bind(
    day,
    `-${SOURCE_CLAIM_STALE_MINUTES} minutes`,
    `-${DEGRADED_SOURCE_RETRY_HOURS} hours`,
    `-${SOURCE_RETRY_MINUTES} minutes`,
  ).run();
  if (Number(claim?.meta?.changes || 0) !== 1) {
    if (row.source_sync_status === "degraded" || (row.source_sync_status === "running" && Number(row.source_sync_attempts || 0) >= MAX_BLOCKING_SOURCE_ATTEMPTS)) {
      return { ready: true, skipped: true, degraded: true, warning: row.source_sync_error || "contract_source_degraded" };
    }
    if (row.source_sync_status === "failed") {
      return { ready: false, reason: "source_sync_retry_wait", attempts: Number(row.source_sync_attempts || 0) };
    }
    return { ready: false, reason: "source_sync_in_progress" };
  }

  try {
    const seeded = await seedCompanies(db);
    const contracts = await syncContracts(env);
    if (!contractSourceReady(contracts)) {
      const detail = JSON.stringify(contracts?.errors || []).slice(0, 800);
      const cause = contracts?.suspicious_empty ? "all contract queries returned zero valid jobs" : (detail || "all contract queries failed");
      throw new Error(`contract_source_unavailable:${cause}`);
    }
    const warning = contracts.errors?.length ? JSON.stringify(contracts.errors).slice(0, 2000) : null;
    await db.batch([
      db.prepare(`
        UPDATE daily_job_digest
        SET source_sync_status = 'complete', source_sync_completed_at = datetime('now'),
            source_sync_error = ?, updated_at = datetime('now')
        WHERE scan_day = ?
      `).bind(warning, day),
      db.prepare("UPDATE scan_scheduler_state SET last_error = NULL, updated_at = datetime('now') WHERE name = ?")
        .bind(STATE_NAME),
    ]);
    const outcome = { ready: true, seeded, contracts, warning };
    console.log(JSON.stringify({ event: "daily_source_sync_complete", day, seeded, contracts }));
    return outcome;
  } catch (error) {
    const message = String(error?.message || error).slice(0, 1000);
    const attempt = Number(row.source_sync_attempts || 0) + 1;
    const degraded = sourceFailureDisposition(row.source_sync_attempts, row.source_sync_status) === "degraded";
    const storedError = degraded ? `contract_source_degraded:${message}`.slice(0, 1000) : message;
    await db.batch([
      db.prepare(`
        UPDATE daily_job_digest
        SET source_sync_status = ?,
            source_sync_completed_at = CASE WHEN ? = 'degraded' THEN COALESCE(source_sync_completed_at, datetime('now')) ELSE source_sync_completed_at END,
            source_sync_error = ?, updated_at = datetime('now')
        WHERE scan_day = ?
      `).bind(degraded ? "degraded" : "failed", degraded ? "degraded" : "failed", storedError, day),
      db.prepare("UPDATE scan_scheduler_state SET last_error = ?, updated_at = datetime('now') WHERE name = ?")
        .bind(degraded ? `source_sync_degraded:${message}` : `source_sync:${message}`, STATE_NAME),
    ]);
    console.error(JSON.stringify({ event: degraded ? "daily_source_sync_degraded" : "daily_source_sync_failed", day, attempt, error: message }));
    if (degraded) {
      return { ready: true, degraded: true, reason: "source_sync_degraded", warning: storedError, attempts: attempt };
    }
    return { ready: false, reason: "source_sync_failed", error: message, attempts: attempt };
  }
}

async function loadState(db) {
  return db.prepare("SELECT * FROM scan_scheduler_state WHERE name = ?").bind(STATE_NAME).first();
}

export function contractSourceReady(result) {
  return result?.ok === true && Number(result?.found || 0) > 0;
}

export function sourceFailureDisposition(previousAttempts, previousStatus = "failed") {
  const attempt = Number(previousAttempts || 0) + 1;
  return previousStatus === "degraded" || attempt >= MAX_BLOCKING_SOURCE_ATTEMPTS ? "degraded" : "failed";
}

export function nextScanStartJobId(previousEndJobId, currentMaxJobId) {
  const previous = Number(previousEndJobId);
  if (previousEndJobId != null && Number.isFinite(previous) && previous >= 0) return previous;
  const current = Number(currentMaxJobId);
  return Number.isFinite(current) && current >= 0 ? current : 0;
}

export function scanDayToRun(state, today) {
  return state?.scan_day && !state.completed_at ? state.scan_day : today;
}

function sqliteNow() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}
