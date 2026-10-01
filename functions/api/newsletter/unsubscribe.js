// GET /api/newsletter/unsubscribe?token=…
// One-click unsubscribe from digest/welcome emails. The token is signed
// (see signUnsubscribeToken in userAuth.js), so no login is required.
// Brand-aware: a token minted for one brand opts out that brand's funnel
// row; legacy brand-less tokens opt out every brand row for the address.

import { ensureSchema } from "../../_shared/db.js";
import { json, corsHeaders, onRequestOptions } from "../../_shared/adminAuth.js";
import { verifyUnsubscribeToken } from "../../_shared/userAuth.js";

export { onRequestOptions as onRequest };

export async function onRequestGet({ request, env }) {
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);
  const url = new URL(request.url);
  const verified = await verifyUnsubscribeToken(url.searchParams.get("token") || "", env).catch(() => null);
  if (!verified) return json({ ok: false, error: "invalid_token" }, 400, request, env);
  const { email, brand } = verified;

  const db = env.JOBS_DB;
  const now = new Date().toISOString();
  // Funnel contacts: opt out the token's brand, or every brand for legacy tokens.
  const rows = brand
    ? await db.prepare("SELECT id, brand FROM email_contact WHERE email = ? AND brand = ?").bind(email, brand).all().then(r => r.results || []).catch(() => [])
    : await db.prepare("SELECT id, brand FROM email_contact WHERE email = ?").bind(email).all().then(r => r.results || []).catch(() => []);
  let funnelOptedOut = 0;
  for (const c of rows) {
    const r = await db.prepare("UPDATE email_contact SET status = 'opted_out' WHERE id = ? AND status != 'opted_out'").bind(c.id).run().catch(() => null);
    if (Number(r?.meta?.changes || 0) > 0) {
      funnelOptedOut++;
      await db.prepare("INSERT INTO email_event (contact_id, brand, kind, meta_json) VALUES (?, ?, 'unsubscribe', ?)")
        .bind(c.id, c.brand, JSON.stringify({ via: "one_click_token", ts: now })).run().catch(() => {});
      await db.prepare("UPDATE contact_engagement SET suppressed_at = ?, suppress_reason = 'unsubscribed', updated_at = ? WHERE contact_id = ?")
        .bind(now, now, c.id).run().catch(() => {});
    }
  }
  // Anonymous newsletter list.
  await db.prepare("UPDATE newsletter_subscriber SET status = 'unsubscribed' WHERE email = ? AND status != 'unsubscribed'")
    .bind(email).run().catch(() => null);
  // Member account preference (legacy behavior).
  const r = await db.prepare("UPDATE app_user SET newsletter_opt_in = 0 WHERE lower(email) = ?")
    .bind(email).run().catch(() => null);
  const changed = Number(r?.meta?.changes || 0);
  return json({ ok: true, email, brand: brand || "all", funnel_opted_out: funnelOptedOut, unsubscribed: changed > 0 || funnelOptedOut > 0 }, 200, request, env);
}
