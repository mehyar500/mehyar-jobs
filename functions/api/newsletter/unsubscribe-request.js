// POST /api/newsletter/unsubscribe-request  { email }
// Emails a one-click unsubscribe link to the address (best-effort).
// Always returns ok:true so the endpoint can't be used to enumerate accounts.
import { ensureSchema } from "../../_shared/db.js";
import { json, onRequestOptions } from "../../_shared/adminAuth.js";
import { signUnsubscribeToken } from "../../_shared/userAuth.js";
import { sendEmail } from "../../_shared/email.js";

export { onRequestOptions as onRequest };

export async function onRequestPost({ request, env }) {
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);

  let body = {};
  try { body = await request.json(); } catch { /* fall through */ }
  const raw = String(body.email || "").trim().toLowerCase();
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw) ? raw : "";

  if (email) {
    const user = await env.JOBS_DB.prepare(
      "SELECT id, email, display_name, newsletter_opt_in FROM app_user WHERE lower(email) = ?"
    ).bind(email).first().catch(() => null);
    if (user) {
      const appUrl = env?.JOBS_APP_URL || env?.APP_HOST || "https://jobs.mehyar.us";
      try {
        const token = await signUnsubscribeToken(user.email, env);
        const link = `${appUrl}/unsubscribe?token=${encodeURIComponent(token)}`;
        await sendEmail(env, {
          to: user.email,
          subject: "mehyar.jobs — unsubscribe link",
          text: `Hi ${user.display_name || "there"},\n\nClick this link to unsubscribe from mehyar.jobs emails:\n\n${link}\n\nIf you didn't ask for this, just ignore it.\n\n— mehyar.jobs`,
          html: `<p>Hi ${user.display_name || "there"},</p><p><a href="${link}">Click here to unsubscribe</a> from mehyar.jobs emails.</p><p>If you didn't ask for this, just ignore it.</p><p>— mehyar.jobs</p>`,
        });
      } catch { /* best-effort */ }
    }
  }
  return json({ ok: true }, 200, request, env);
}
