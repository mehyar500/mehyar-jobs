// Admin: seed-test records (pre-send gate).
// POST /api/admin/email/seed-test { template, inboxPct, spamPct, notes? }
// A campaign template is blocked until its latest record shows inbox >= 80% and spam <= 5%.

import { json, onRequestOptions, requireAdmin } from "../../../_shared/adminAuth.js";
import { ensureSchema } from "../../../_shared/db.js";
import { recordSeedTest, preSendGateCheck } from "../../../_shared/emailFunnel.js";

export { onRequestOptions as onRequest };

export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message || "unauthorized" }, auth.status || 401, request, env);
  await ensureSchema(env).catch(() => null);
  let b = {};
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400, request, env); }
  const inboxPct = Number(b.inboxPct), spamPct = Number(b.spamPct);
  if (!b.template || !(inboxPct >= 0) || !(spamPct >= 0)) {
    return json({ ok: false, error: "bad_input" }, 400, request, env);
  }
  await recordSeedTest(env.JOBS_DB, { template: b.template, inboxPct, spamPct, notes: b.notes || "" });
  const check = await preSendGateCheck(env.JOBS_DB, b.template);
  return json({ ok: true, gate: check }, 200, request, env);
}
