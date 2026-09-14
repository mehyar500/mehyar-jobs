// POST /api/public/offer-email — double-opt-in email capture for the
// SMS offer landing page. Feeds the newsletter system: the address stays
// 'pending' until the confirm link is tapped, then 'confirmed'.

import { json, onRequestOptions } from "../../_shared/adminAuth.js";
import { ensureSchema } from "../../_shared/db.js";
import { sendEmail } from "../../_shared/email.js";
import { mintPublicId } from "../../_shared/sms.js";
import { APP_URL } from "../../_shared/seo.js";

export { onRequestOptions as onRequest };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function onRequestPost({ request, env }) {
  await ensureSchema(env).catch(() => null);
  const db = env?.JOBS_DB;
  if (!db) return json({ ok: false, error: "no_db" }, 500, request, env);
  let body = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400, request, env); }

  const email = String(body.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return json({ ok: false, error: "bad_email" }, 400, request, env);
  const source = String(body.source || "offer_page").slice(0, 32);

  const existing = await db.prepare("SELECT id, status FROM newsletter_subscriber WHERE email = ?")
    .bind(email).first().catch(() => null);
  if (existing?.status === "confirmed") return json({ ok: true, already: true }, 200, request, env);

  const token = mintPublicId("nl");
  if (existing) {
    await db.prepare("UPDATE newsletter_subscriber SET status = 'pending', confirm_token = ?, source = ? WHERE id = ?")
      .bind(token, source, existing.id).run().catch(() => {});
  } else {
    await db.prepare("INSERT INTO newsletter_subscriber (email, status, source, confirm_token) VALUES (?, 'pending', ?, ?)")
      .bind(email, source, token).run().catch(() => {});
  }

  const confirmUrl = `${APP_URL}/api/public/offer-email-confirm?token=${encodeURIComponent(token)}`;
  const unsubUrl = `${APP_URL}/unsubscribe`;
  await sendEmail(env, {
    to: email,
    subject: "Confirm your mehyar.jobs daily alerts",
    text: `One tap to confirm your daily job alerts from mehyar.jobs:\n\n${confirmUrl}\n\nDidn't ask for this? Ignore it — nothing happens.\nUnsubscribe anytime: ${unsubUrl}`,
    html: `<p>One tap to confirm your <b>daily job alerts</b> from mehyar.jobs:</p><p><a href="${confirmUrl}">Confirm my alerts →</a></p><p style="font-size:12px;color:#777">Didn't ask for this? Ignore it — nothing happens. Unsubscribe anytime: <a href="${unsubUrl}">${unsubUrl}</a></p>`,
  }).catch(() => null);

  return json({ ok: true }, 200, request, env);
}
