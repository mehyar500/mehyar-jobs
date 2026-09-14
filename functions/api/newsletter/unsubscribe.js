// GET /api/newsletter/unsubscribe?token=…
// One-click unsubscribe from digest/welcome emails. The token is signed
// (see signUnsubscribeToken in userAuth.js), so no login is required.
import { ensureSchema } from "../../_shared/db.js";
import { json, corsHeaders, onRequestOptions } from "../../_shared/adminAuth.js";
import { verifyUnsubscribeToken } from "../../_shared/userAuth.js";

export { onRequestOptions as onRequest };

export async function onRequestGet({ request, env }) {
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);
  const url = new URL(request.url);
  const email = await verifyUnsubscribeToken(url.searchParams.get("token") || "", env).catch(() => null);
  if (!email) return json({ ok: false, error: "invalid_token" }, 400, request, env);

  const db = env.JOBS_DB;
  const r = await db.prepare("UPDATE app_user SET newsletter_opt_in = 0 WHERE lower(email) = ?")
    .bind(email).run().catch(() => null);
  const changed = Number(r?.meta?.changes || 0);
  return json({ ok: true, email, unsubscribed: changed > 0 }, 200, request, env);
}
