import { ensureSchema } from "../../functions/_shared/db.js";
import { scanCompanyBatch, syncContractJobs, syncSeedCompanies } from "../../functions/_shared/scan.js";

const STATE_NAME = "daily-company-scan";

export default {
  async scheduled(controller, env, ctx) {
    await runScheduledBatch(env, controller.cron || "cron");
  },

  async fetch(request, env) {
    if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
    await ensureSchema(env);
    const state = await env.JOBS_DB.prepare("SELECT * FROM scan_scheduler_state WHERE name = ?").bind(STATE_NAME).first();
    return json({ ok: true, service: "mehyar-jobs-scanner", state, ts: new Date().toISOString() });
  },
};

export async function runScheduledBatch(env, cron = "cron") {
  await ensureSchema(env);
  const db = env.JOBS_DB;
  const day = new Date().toISOString().slice(0, 10);
  let state = await db.prepare("SELECT * FROM scan_scheduler_state WHERE name = ?").bind(STATE_NAME).first();

  if (!state || state.scan_day !== day) {
    await syncSeedCompanies(db);
    const contracts = await syncContractJobs(env);
    await db.prepare(`
      INSERT INTO scan_scheduler_state (name, scan_day, cursor, completed_at, last_error, updated_at)
      VALUES (?, ?, 0, NULL, ?, datetime('now'))
      ON CONFLICT(name) DO UPDATE SET
        scan_day = excluded.scan_day,
        cursor = 0,
        completed_at = NULL,
        last_error = excluded.last_error,
        updated_at = datetime('now')
    `).bind(STATE_NAME, day, contracts.ok ? null : JSON.stringify(contracts.errors).slice(0, 1000)).run();
    state = { scan_day: day, cursor: 0, completed_at: null };
  }

  if (state.completed_at) {
    console.log(JSON.stringify({ event: "daily_scan_already_complete", day, completed_at: state.completed_at }));
    return { ok: true, skipped: true, reason: "already_complete", day };
  }

  try {
    const batch = await scanCompanyBatch(env, { afterId: state.cursor || 0, limit: 3, trigger: `scheduled:${cron}` });
    await db.prepare(`
      UPDATE scan_scheduler_state
      SET cursor = ?, completed_at = ?, last_error = NULL, updated_at = datetime('now')
      WHERE name = ?
    `).bind(batch.cursor || 0, batch.done ? sqliteNow() : null, STATE_NAME).run();
    console.log(JSON.stringify({ event: "daily_scan_batch", day, ...batch }));
    return batch;
  } catch (error) {
    const message = String(error?.message || error).slice(0, 1000);
    await db.prepare("UPDATE scan_scheduler_state SET last_error = ?, updated_at = datetime('now') WHERE name = ?")
      .bind(message, STATE_NAME).run();
    console.error(JSON.stringify({ event: "daily_scan_failed", day, cursor: state.cursor || 0, error: message }));
    throw error;
  }
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
