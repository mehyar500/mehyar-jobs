// POST /api/email/webhook — ESP event ingestion (opens/clicks/bounces/complaints/unsubscribes).
//
// Body: { provider: "smtp2go"|"brevo", email, event, mpp_suspect?, meta? }
// Event names are normalized across providers (smtp2go: open/click/bounce/spam;
// brevo: opened/click/hard_bounce/soft_bounce/spam/unsubscribed).
// Apple-proxy opens should arrive with mpp_suspect: true and are counted
// but never trusted for engagement banding.

import { ensureSchema } from "../../_shared/db.js";
import { recordEmailEvent } from "../../_shared/emailFunnel.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export async function onRequestPost({ request, env }) {
  await ensureSchema(env).catch(() => null);
  const db = env?.JOBS_DB;
  if (!db) return json({ ok: false, error: "no_db" }, 500);
  let b = {};
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }
  const res = await recordEmailEvent(db, b.email, b.event, { mppSuspect: b.mpp_suspect === true, meta: b.meta || { provider: b.provider } });
  return json(res, res.ok ? 200 : 202);
}
