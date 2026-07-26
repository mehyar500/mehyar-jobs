// /api/admin/digest
//
//   GET  → builds the daily digest, returns the JSON preview (no email)
//   POST → builds the digest AND emails it to NOTIFY_EMAIL
//
// The cron worker also calls POST once per day at 18:00 to send
// the user's "summation email".

import { requireAdmin, json, corsHeaders, onRequestOptions } from "../../_shared/adminAuth.js";
import { ensureSchema } from "../../_shared/db.js";
import { buildDigest } from "../../_shared/digest.js";
import { sendEmail } from "../../_shared/email.js";
import { loadProfile } from "../../_shared/fit.js";

export { onRequestOptions as onRequest };

export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);
  const url = new URL(request.url);
  const daysBack = Math.max(1, Math.min(30, parseInt(url.searchParams.get("days") || "1", 10)));
  const profile = await loadProfile(env);
  const digest = await buildDigest(env, { daysBack, profile });
  return json({ ok: true, ...digest, recipient: env?.NOTIFY_EMAIL || env?.USER_EMAIL || null }, 200, request, env);
}

export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);
  const profile = await loadProfile(env);
  const digest = await buildDigest(env, { daysBack: 1, profile });
  const recipient = env?.NOTIFY_EMAIL || env?.USER_EMAIL || profile?.email || null;
  const r = await sendEmail(env, { to: recipient, subject: digest.subject, text: digest.text, html: digest.html });
  return json({ ok: true, sent: r.ok, error: r.error || null, recipient, digest_preview: { counts: digest.counts, subject: digest.subject } }, 200, request, env);
}
