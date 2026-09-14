// POST /api/auth/signup
//
// Public account creation. Marketing consent is separate from account
// creation: the newsletter checkbox is optional (unchecked by default).
// Opted-in members get the daily digest via the scanner worker; anyone
// can toggle the newsletter later from account settings.

import { ensureSchema } from "../../_shared/db.js";
import {
  json, corsHeaders, onRequestOptions,
  hashPassword, signUserToken, signUnsubscribeToken, deriveProfileFromResume,
} from "../../_shared/userAuth.js";
import { makeReferralCode, normalizeCode, creditReferral } from "../../_shared/referral.js";

export { onRequestOptions as onRequest };

const RL = new Map();
function rateLimitOk(ip, limit, windowMs) {
  const now = Date.now();
  const arr = (RL.get(ip) || []).filter((ts) => now - ts < windowMs);
  if (arr.length >= limit) return false;
  arr.push(now);
  RL.set(ip, arr);
  return true;
}
const str = (v, max) => typeof v === "string" ? v.trim().slice(0, max) : "";
const arr = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string").map((x) => x.trim()).filter(Boolean).slice(0, 20) : [];

export async function onRequestPost({ request, env }) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (!rateLimitOk(ip, 10, 15 * 60 * 1000)) {
    return json({ ok: false, error: "rate_limited" }, 429, request, env);
  }
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);
  const db = env.JOBS_DB;

  let body = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad_request" }, 400, request, env); }

  const email = str(body.email, 320).toLowerCase();
  const password = typeof body.password === "string" ? body.password : "";
  const display_name = str(body.display_name || body.name, 120);
  const newsletter = body.newsletter_opt_in === true || body.newsletter_opt_in === 1 || body.newsletter_opt_in === "1";

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return json({ ok: false, error: "invalid_email" }, 400, request, env);
  }
  if (password.length < 8) {
    return json({ ok: false, error: "password_too_short", min: 8 }, 400, request, env);
  }
  // NOTE: newsletter opt-in is NOT required for account creation — the
  // checkbox on the signup page is a separate, optional consent.

  const existing = await db.prepare("SELECT id FROM app_user WHERE lower(email) = ?").bind(email).first().catch(() => null);
  if (existing) return json({ ok: false, error: "email_taken" }, 409, request, env);

  const password_hash = await hashPassword(password);

  // Referral: ?ref=MJ-XXXXXX (body or query). Credits both sides +10 chats.
  let refCode = normalizeCode(body.ref) || normalizeCode(new URL(request.url).searchParams.get("ref"));
  let referrer = null;
  if (refCode) {
    referrer = await db.prepare("SELECT id FROM app_user WHERE referral_code = ?").bind(refCode).first().catch(() => null);
    if (!referrer) refCode = null;
  }

  const myCode = makeReferralCode();
  const ins = await db.prepare(`
    INSERT INTO app_user (email, password_hash, display_name, newsletter_opt_in, referral_code, referred_by_code)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(email, password_hash, display_name || null, newsletter ? 1 : 0, myCode, refCode).run().catch(() => null);
  const userId = ins?.meta?.last_row_id;
  if (!userId) return json({ ok: false, error: "signup_failed" }, 500, request, env);

  if (referrer && referrer.id !== userId) {
    await creditReferral(db, referrer.id, userId);
  }

  // First-pass fit profile from the signup hints (refined on resume upload).
  const derived = deriveProfileFromResume("", {
    current_title: str(body.current_title, 120),
    target_titles: arr(body.target_titles),
    locations: arr(body.locations),
  });
  await db.prepare(`
    INSERT OR IGNORE INTO user_profile
      (user_id, target_titles_json, keywords_json, locations_json)
    VALUES (?, ?, ?, ?)
  `).bind(
    userId,
    JSON.stringify(derived.target_titles),
    JSON.stringify(derived.keywords),
    JSON.stringify(derived.locations)
  ).run().catch(() => null);

  const token = await signUserToken(userId, env).catch(() => null);
  if (!token) return json({ ok: false, error: "auth_not_configured" }, 500, request, env);

  // No signup emails are sent (per owner: no transactional email on signup).


  return json({ ok: true, token, user: { id: userId, email, display_name: display_name || null, referral_code: myCode, referred: !!referrer } }, 200, request, env);
}
