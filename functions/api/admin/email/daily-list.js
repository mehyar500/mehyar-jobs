// Admin: daily send-list plan + queue.
//
// GET  /api/admin/email/daily-list  -> dry-run plan (list composition, sample personalization; no sends)
// POST /api/admin/email/daily-list { live?: bool, kind?: "warmup"|"repermission"|"digest"|"promo" }
//   DRY-RUN BY DEFAULT: rows are recorded with status 'dry_run' and nothing
//   touches an ESP unless { live: true } AND EMAIL_LIVE=1.

import { json, onRequestOptions, requireAdmin } from "../../../_shared/adminAuth.js";
import { ensureSchema } from "../../../_shared/db.js";
import { buildDailyList, queueDailySends, personalizeForContact } from "../../../_shared/emailFunnel.js";
import { signUnsubscribeToken } from "../../../_shared/userAuth.js";

export { onRequestOptions as onRequest };

export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message || "unauthorized" }, auth.status || 401, request, env);
  await ensureSchema(env).catch(() => null);
  const db = env?.JOBS_DB;
  const plan = await buildDailyList(db, { now: new Date(), env });
  // Sample personalization for the first 3 recipients (preview only).
  const samples = [];
  for (const c of plan.list.slice(0, 3)) {
    const p = await personalizeForContact(db, c);
    samples.push({ email: c.email, variant: c.variant, provider: c.provider, band: c.band, matches: p.matches.length, resumeScore: p.resumeScore, hasResume: p.hasResume });
  }
  return json({ ok: true, cap: plan.cap, counts: plan.counts, planned: plan.list.length, samples, blocked: plan.blocked || null }, 200, request, env);
}

export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message || "unauthorized" }, auth.status || 401, request, env);
  await ensureSchema(env).catch(() => null);
  const db = env?.JOBS_DB;
  let b = {};
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400, request, env); }
  const live = b.live === true;
  const kind = ["warmup", "repermission", "digest", "promo"].includes(b.kind) ? b.kind : "warmup";
  const res = await queueDailySends(db, env, {
    live, kind, now: new Date(), appUrl: "https://jobs.mehyar.us",
    signUnsub: (email, e) => signUnsubscribeToken(email, e),
  });
  return json({ ok: res.ok, live, ...res }, res.ok ? 200 : 409, request, env);
}
