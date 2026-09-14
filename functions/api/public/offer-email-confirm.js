// GET /api/public/offer-email-confirm?token= — double-opt-in confirm.

import { ensureSchema } from "../../_shared/db.js";
import { pageChrome, APP_URL } from "../../_shared/seo.js";

export async function onRequestGet({ env, request }) {
  const url = new URL(request.url);
  const token = String(url.searchParams.get("token") || "").slice(0, 64);
  await ensureSchema(env).catch(() => null);
  const db = env?.JOBS_DB;

  const row = token && db
    ? await db.prepare("SELECT id, email, status FROM newsletter_subscriber WHERE confirm_token = ?")
      .bind(token).first().catch(() => null)
    : null;

  if (!row) {
    const html = pageChrome({ title: "Link expired — mehyar.jobs", noindex: true,
      body: `<h1>Link expired</h1><p class="muted">That confirmation link is used or invalid. <a href="${APP_URL}/">Try again →</a></p>` });
    return new Response(html, { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  await db.prepare("UPDATE newsletter_subscriber SET status = 'confirmed', confirmed_at = datetime('now'), confirm_token = NULL WHERE id = ?")
    .bind(row.id).run().catch(() => {});
  const html = pageChrome({ title: "You're in — mehyar.jobs", noindex: true,
    body: `<h1>✅ You're in</h1><p>Daily job alerts are heading to <b>${row.email.replace(/</g, "&lt;")}</b>.</p><p class="muted">One-click unsubscribe in every email.</p><a class="btn" href="${APP_URL}/">Browse 7,000+ jobs →</a>` });
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
