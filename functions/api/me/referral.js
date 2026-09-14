// GET /api/me/referral — the member's invite link + credit balance.
//
// Returns: { code, url, chat_bonus_credits, referred_count }
// A code is minted on first call (backfills older accounts).

import { json, onRequestOptions } from "../../_shared/adminAuth.js";
import { ensureSchema } from "../../_shared/db.js";
import { requireUser } from "../../_shared/userAuth.js";
import { ensureReferralCode } from "../../_shared/referral.js";

export { onRequestOptions as onRequest };

export async function onRequestGet({ request, env }) {
  const auth = await requireUser(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  await ensureSchema(env).catch(() => null);
  const db = env.JOBS_DB;

  const code = await ensureReferralCode(db, auth.user.id);
  const me = await db.prepare("SELECT chat_bonus_credits FROM app_user WHERE id = ?")
    .bind(auth.user.id).first().catch(() => ({ chat_bonus_credits: 0 }));
  const count = await db.prepare("SELECT COUNT(*) AS n FROM referral_event WHERE referrer_user_id = ?")
    .bind(auth.user.id).first().catch(() => ({ n: 0 }));

  const appUrl = env.JOBS_APP_URL || "https://jobs.mehyar.us";
  return json({
    ok: true,
    code,
    url: code ? `${appUrl}/signup?ref=${encodeURIComponent(code)}` : null,
    chat_bonus_credits: me?.chat_bonus_credits || 0,
    referred_count: count?.n || 0,
  }, 200, request, env);
}
