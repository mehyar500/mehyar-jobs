// Admin: sender wire-up readiness checklist + ARM button.
//
// POST /api/admin/email/wire-up
//
// Runs one check per dependency and, only if every check passes, stamps
// system_flag.sender_armed with the current ISO time and returns
// armed:true. This endpoint NEVER sends email.
//
// NOTE: Campaign control has moved to the chat control plane
// (POST /api/agent/email/control). This admin endpoint is kept for
// backward compatibility; the dashboard Jobs tab is reporting-only.

import { json, onRequestOptions, requireAdmin } from "../../../_shared/adminAuth.js";
import { ensureSchema } from "../../../_shared/db.js";
import { runReadinessChecks, armSender } from "../../../_shared/readinessChecks.js";

export { onRequestOptions as onRequest };

export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message || "unauthorized" }, auth.status || 401, request, env);
  await ensureSchema(env).catch(() => null);
  const db = env?.JOBS_DB;

  const { checks, armed } = await runReadinessChecks(db, env);
  let armedAt = null;
  if (armed) {
    armedAt = await armSender(db);
  }
  return json({ ok: true, armed, armed_at: armedAt, checks }, 200, request, env);
}
