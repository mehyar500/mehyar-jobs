// Admin: read the campaign-brain plan for a date.
//
// GET /api/admin/email/brain-plan?date=YYYY-MM-DD
//   date defaults to today (UTC); bad format -> 400; no plan row -> 404.
//   Returns the parsed plan_json, reasoning_text, model, created_at.
//   Read-only: this endpoint never writes plans and never touches EMAIL_LIVE.

import { json, onRequestOptions, requireAdmin } from "../../../_shared/adminAuth.js";
import { ensureSchema } from "../../../_shared/db.js";
import { readPlanRow } from "../../../_shared/campaignPlan.js";

export { onRequestOptions as onRequest };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message || "unauthorized" }, auth.status || 401, request, env);
  await ensureSchema(env).catch(() => null);

  const url = new URL(request.url);
  let dateStr = url.searchParams.get("date");
  if (!dateStr) dateStr = new Date().toISOString().slice(0, 10);
  if (!DATE_RE.test(dateStr)) {
    return json({ ok: false, error: "bad_date: use YYYY-MM-DD" }, 400, request, env);
  }

  const row = await readPlanRow(env.JOBS_DB, dateStr);
  if (!row) {
    return json({ ok: false, error: "no_plan", date: dateStr }, 404, request, env);
  }
  return json({
    ok: true,
    date: row.plan_date,
    plan: row.plan,
    reasoning_text: row.reasoning_text,
    model: row.model,
    created_at: row.created_at,
  }, 200, request, env);
}
