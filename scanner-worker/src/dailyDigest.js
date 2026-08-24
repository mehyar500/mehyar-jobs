import { buildDailyJobsDigest, digestDisposition, loadDailyJobs, loadDailyScanStats } from "../../functions/_shared/dailyJobsDigest.js";

const STALE_EMAIL_CLAIM_HOURS = 2;
const MAX_EMAIL_CONTENT_BYTES = 20 * 1024 * 1024;

export async function ensureLegacyDigestForCompletedState(db, state, recipient) {
  if (!state?.scan_day || !state?.completed_at) return null;
  const existing = await db.prepare("SELECT * FROM daily_job_digest WHERE scan_day = ?").bind(state.scan_day).first();
  if (existing) return existing;

  const bounds = await db.prepare(`
    SELECT COALESCE(MAX(id), 0) AS end_job_id
    FROM job
    WHERE first_seen_at >= ?
      AND first_seen_at < datetime(?, '+1 day')
  `).bind(state.scan_day, state.scan_day).first();
  await db.prepare(`
    INSERT OR IGNORE INTO daily_job_digest (
      scan_day, selection_mode, scan_started_at, start_job_id, scan_completed_at, end_job_id,
      source_sync_status, source_sync_completed_at, email_status, recipient, updated_at
    ) VALUES (?, 'utc_day', ?, 0, ?, ?, 'complete', ?, 'pending', ?, datetime('now'))
  `).bind(
    state.scan_day,
    `${state.scan_day} 00:00:00`,
    state.completed_at,
    Number(bounds?.end_job_id || 0),
    state.completed_at,
    recipient,
  ).run();
  return db.prepare("SELECT * FROM daily_job_digest WHERE scan_day = ?").bind(state.scan_day).first();
}

export async function deliverOldestCompletedDigest(env) {
  const db = env.JOBS_DB;
  const candidate = await db.prepare(`
    SELECT *
    FROM daily_job_digest
    WHERE scan_completed_at IS NOT NULL
      AND (
        email_status = 'pending'
        OR (email_status = 'failed' AND (email_next_attempt_at IS NULL OR email_next_attempt_at <= datetime('now')))
        OR (email_status = 'sending' AND email_claimed_at < datetime('now', ?))
      )
    ORDER BY scan_day ASC
    LIMIT 1
  `).bind(`-${STALE_EMAIL_CLAIM_HOURS} hours`).first();
  if (!candidate) return { ok: true, skipped: true, reason: "no_claimable_digest" };
  return deliverDailyDigest(env, candidate.scan_day);
}

export async function deliverDailyDigest(env, scanDay) {
  const db = env.JOBS_DB;
  const claim = await db.prepare(`
    UPDATE daily_job_digest
    SET email_status = 'sending',
        email_attempts = email_attempts + 1,
        email_claimed_at = datetime('now'),
        email_last_error = NULL,
        email_error_code = NULL,
        email_next_attempt_at = NULL,
        updated_at = datetime('now')
    WHERE scan_day = ?
      AND scan_completed_at IS NOT NULL
      AND (
        email_status = 'pending'
        OR (email_status = 'failed' AND (email_next_attempt_at IS NULL OR email_next_attempt_at <= datetime('now')))
        OR (email_status = 'sending' AND email_claimed_at < datetime('now', ?))
      )
  `).bind(scanDay, `-${STALE_EMAIL_CLAIM_HOURS} hours`).run();
  if (Number(claim?.meta?.changes || 0) !== 1) {
    const current = await db.prepare("SELECT * FROM daily_job_digest WHERE scan_day = ?").bind(scanDay).first();
    return { ok: true, skipped: true, reason: digestDisposition(current), scan_day: scanDay };
  }

  let digestRow = null;
  try {
    digestRow = await db.prepare("SELECT * FROM daily_job_digest WHERE scan_day = ?").bind(scanDay).first();
    if (!digestRow) throw new Error("daily_digest_claim_disappeared");
    if (!env.EMAIL || typeof env.EMAIL.send !== "function") throw new Error("EMAIL binding missing");

    const jobs = await loadDailyJobs(db, digestRow);
    const scanStats = await loadDailyScanStats(db, digestRow);
    const appUrl = env.JOBS_APP_URL || "https://jobs.mehyar.us";
    const digest = buildDailyJobsDigest(jobs, { scanDay, appUrl, scanStats });
    const contentBytes = new TextEncoder().encode(`${digest.subject}\n${digest.text}\n${digest.html}\n${digest.csv}`).byteLength;
    if (contentBytes > MAX_EMAIL_CONTENT_BYTES) throw new Error(`daily_digest_too_large:${contentBytes}`);

    await db.prepare(`
      UPDATE daily_job_digest
      SET job_count = ?, high_fit_count = ?, contract_count = ?, remote_count = ?, updated_at = datetime('now')
      WHERE scan_day = ?
    `).bind(digest.counts.total, digest.counts.highFit, digest.counts.contract, digest.counts.remote, scanDay).run();

    const recipient = digestRow.recipient || env.DIGEST_TO_EMAIL || "mrswelim@gmail.com";
    const sender = env.DIGEST_FROM_EMAIL || "noreply@mehyar.us";
    const result = await env.EMAIL.send({
      to: recipient,
      from: { email: sender, name: "mehyar.jobs" },
      replyTo: env.DIGEST_REPLY_TO || "info@mehyar.us",
      subject: digest.subject,
      text: digest.text,
      html: digest.html,
      headers: { "X-Campaign-ID": `daily-jobs-${scanDay}` },
      attachments: [digest.attachment],
    });

    await db.prepare(`
      UPDATE daily_job_digest
      SET email_status = 'sent',
          email_sent_at = datetime('now'),
          email_message_id = ?,
          email_last_error = NULL,
          email_error_code = NULL,
          email_next_attempt_at = NULL,
          updated_at = datetime('now')
      WHERE scan_day = ?
    `).bind(result?.messageId || null, scanDay).run();
    const outcome = {
      ok: true,
      sent: true,
      scan_day: scanDay,
      recipient,
      message_id: result?.messageId || null,
      counts: digest.counts,
      content_bytes: contentBytes,
    };
    console.log(JSON.stringify({ event: "daily_job_digest_sent", ...outcome }));
    return outcome;
  } catch (error) {
    const message = String(error?.message || error).slice(0, 1000);
    const failure = classifyEmailFailure(error, Number(digestRow?.email_attempts || 1));
    await db.prepare(`
      UPDATE daily_job_digest
      SET email_status = ?,
          email_last_error = ?,
          email_error_code = ?,
          email_next_attempt_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', ?) END,
          updated_at = datetime('now')
      WHERE scan_day = ? AND email_status = 'sending'
    `).bind(failure.status, message, failure.code, failure.retryModifier, failure.retryModifier, scanDay).run().catch(() => null);
    console.error(JSON.stringify({ event: "daily_job_digest_failed", scan_day: scanDay, error: message, ...failure }));
    return { ok: false, sent: false, scan_day: scanDay, error: message, attempts: Number(digestRow?.email_attempts || 0), ...failure };
  }
}

export function classifyEmailFailure(error, attempt = 1) {
  const code = String(error?.code || "UNKNOWN");
  const message = String(error?.message || error || "");
  const permanentCodes = new Set([
    "E_VALIDATION_ERROR", "E_FIELD_MISSING", "E_SENDER_NOT_VERIFIED",
    "E_RECIPIENT_NOT_ALLOWED", "E_RECIPIENT_SUPPRESSED", "E_SENDER_DOMAIN_NOT_AVAILABLE",
    "E_CONTENT_TOO_LARGE", "E_HEADER_NOT_ALLOWED", "E_HEADER_USE_API_FIELD",
    "E_HEADER_VALUE_INVALID", "E_HEADER_VALUE_TOO_LONG", "E_HEADER_NAME_INVALID",
    "E_HEADERS_TOO_LARGE", "E_HEADERS_TOO_MANY",
  ]);
  const permanentMessage = /EMAIL binding missing|daily_digest_too_large|daily_digest_claim_disappeared/.test(message);
  if (permanentCodes.has(code) || permanentMessage) {
    return { status: "dead_letter", code, retryModifier: null };
  }
  if (code === "E_DAILY_LIMIT_EXCEEDED") {
    return { status: "failed", code, retryModifier: "+6 hours" };
  }
  const delays = [15, 30, 60, 120, 360];
  const minutes = delays[Math.min(delays.length - 1, Math.max(0, Number(attempt || 1) - 1))];
  return { status: "failed", code, retryModifier: `+${minutes} minutes` };
}
