// POST /api/me/newsletter — toggle the newsletter subscription.
// Body: { opt_in: true|false }. Opting out stops digest emails.

import { ensureSchema } from "../../_shared/db.js";
import { json, onRequestOptions, requireUser } from "../../_shared/userAuth.js";

export { onRequestOptions as onRequest };

export async function onRequestPost({ request, env }) {
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);
  const auth = await requireUser(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);

  let body = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad_request" }, 400, request, env); }
  const optIn = body.opt_in === true || body.opt_in === 1 ? 1 : 0;

  await env.JOBS_DB.prepare("UPDATE app_user SET newsletter_opt_in = ? WHERE id = ?")
    .bind(optIn, auth.user.id).run().catch(() => null);

  return json({ ok: true, newsletter_opt_in: optIn === 1 }, 200, request, env);
}
