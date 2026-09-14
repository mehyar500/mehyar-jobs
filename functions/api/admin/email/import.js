// Admin: legacy cohort import into the warm-up funnel.
// POST /api/admin/email/import { contacts: [{ email, firstName?, lastName?, city?, state?, roleTitle?, source?, importedAt? }] }
// Contacts land as status='pending' (never sent). Activation happens only
// through the daily list builder + engagement. Invalid emails are skipped.

import { json, onRequestOptions, requireAdmin } from "../../../_shared/adminAuth.js";
import { ensureSchema } from "../../../_shared/db.js";
import { importEmailContacts } from "../../../_shared/emailFunnel.js";

export { onRequestOptions as onRequest };

export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message || "unauthorized" }, auth.status || 401, request, env);
  await ensureSchema(env).catch(() => null);
  let b = {};
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400, request, env); }
  if (!Array.isArray(b.contacts) || b.contacts.length > 50000) {
    return json({ ok: false, error: "contacts must be an array (max 50000/batch)" }, 400, request, env);
  }
  const res = await importEmailContacts(env.JOBS_DB, b.contacts);
  return json({ ok: true, ...res }, 200, request, env);
}
