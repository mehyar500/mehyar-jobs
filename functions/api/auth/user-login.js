// POST /api/auth/user-login
//
// Public user sign-in (email or username + password). The owner's account
// authenticates through /api/auth/login instead (env-admin marker).

import { ensureSchema } from "../../_shared/db.js";
import {
  json, corsHeaders, onRequestOptions,
  verifyPassword, signUserToken,
} from "../../_shared/userAuth.js";

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

export async function onRequestPost({ request, env }) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (!rateLimitOk(ip, 15, 15 * 60 * 1000)) {
    return json({ ok: false, error: "rate_limited" }, 429, request, env);
  }
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);

  let body = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad_request" }, 400, request, env); }
  const identifier = String(body.email || body.username || "").trim().toLowerCase().slice(0, 320);
  const password = typeof body.password === "string" ? body.password : "";
  if (!identifier || !password) return json({ ok: false, error: "invalid_credentials" }, 401, request, env);

  const user = await env.JOBS_DB.prepare(
    "SELECT * FROM app_user WHERE lower(email) = ? OR lower(username) = ?"
  ).bind(identifier, identifier).first().catch(() => null);

  if (!user) return json({ ok: false, error: "invalid_credentials" }, 401, request, env);
  if (user.password_hash === "env-admin") {
    return json({ ok: false, error: "use_admin_signin", message: "This account signs in with the admin login." }, 401, request, env);
  }
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return json({ ok: false, error: "invalid_credentials" }, 401, request, env);

  const token = await signUserToken(user.id, env).catch(() => null);
  if (!token) return json({ ok: false, error: "auth_not_configured" }, 500, request, env);
  return json({
    ok: true,
    token,
    user: { id: user.id, email: user.email, display_name: user.display_name, is_admin: user.is_admin === 1 },
  }, 200, request, env);
}
