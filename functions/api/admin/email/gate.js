// Admin: Fibonacci gate state + evaluation.
//
// GET  /api/admin/email/gate -> current gate state
// POST /api/admin/email/gate { complaintPct, bouncePct, postmaster?, blocklistHits? }
//   Advances / holds / pauses the warm-up level per the metric gates:
//   advance only if complaints <0.10%, bounce <2%, Postmaster Medium+,
//   zero blocklist hits; pause on critical values.

import { json, onRequestOptions, requireAdmin } from "../../../_shared/adminAuth.js";
import { ensureSchema } from "../../../_shared/db.js";
import { getGate, evaluateGate, FIB_LEVELS } from "../../../_shared/emailFunnel.js";

export { onRequestOptions as onRequest };

export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message || "unauthorized" }, auth.status || 401, request, env);
  await ensureSchema(env).catch(() => null);
  const gate = await getGate(env.JOBS_DB);
  return json({ ok: true, gate, levels: FIB_LEVELS.slice(0, 20) }, 200, request, env);
}

export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message || "unauthorized" }, auth.status || 401, request, env);
  await ensureSchema(env).catch(() => null);
  let b = {};
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400, request, env); }
  const res = await evaluateGate(env.JOBS_DB, {
    complaintPct: Number(b.complaintPct ?? 0),
    bouncePct: Number(b.bouncePct ?? 0),
    postmaster: b.postmaster || null,
    blocklistHits: Number(b.blocklistHits ?? 0),
    now: new Date(),
  });
  return json({ ok: true, decision: res.decision, reason: res.reason, gate: res.gate }, 200, request, env);
}
