// _shared/referral.js — referral codes + bonus-chat crediting.
//
// Invite loop: every user gets a code (MJ-XXXXXX). A referred signup credits
// +BONUS_CHATS to BOTH the referrer and the new user. Credits are burned in
// chat.js once the daily member cap is hit.

export const BONUS_CHATS = 10;

export function makeReferralCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  return "MJ-" + [...buf].map((b) => chars[b % chars.length]).join("");
}

export function normalizeCode(v) {
  const c = String(v || "").trim().toUpperCase();
  return /^MJ-[A-Z2-9]{6}$/.test(c) ? c : null;
}

// Ensure the user has a code; returns it.
export async function ensureReferralCode(db, userId) {
  const row = await db.prepare("SELECT referral_code FROM app_user WHERE id = ?")
    .bind(userId).first().catch(() => null);
  if (row?.referral_code) return row.referral_code;
  for (let i = 0; i < 5; i++) {
    const code = makeReferralCode();
    const r = await db.prepare("UPDATE app_user SET referral_code = ? WHERE id = ? AND referral_code IS NULL")
      .bind(code, userId).run().catch(() => null);
    if (r?.meta?.changes > 0) return code;
  }
  return null;
}

// Credit a successful referral: both sides get BONUS_CHATS.
export async function creditReferral(db, referrerId, referredId) {
  await db.prepare("UPDATE app_user SET chat_bonus_credits = chat_bonus_credits + ? WHERE id = ?")
    .bind(BONUS_CHATS, referrerId).run().catch(() => null);
  await db.prepare("UPDATE app_user SET chat_bonus_credits = chat_bonus_credits + ? WHERE id = ?")
    .bind(BONUS_CHATS, referredId).run().catch(() => null);
  await db.prepare("INSERT INTO referral_event (referrer_user_id, referred_user_id, bonus_chats) VALUES (?, ?, ?)")
    .bind(referrerId, referredId, BONUS_CHATS).run().catch(() => null);
}
