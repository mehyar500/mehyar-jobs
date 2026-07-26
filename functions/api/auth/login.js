// /api/auth/login
//
// Cross-origin-safe login for mehyar.jobs. Same body + same token shape
// as mehyar-web's /api/admin/auth/login, so a token issued here is
// interchangeable on both apps.
//
// Why this exists: mehyar-web's CORS allowlist only reflected the
// configured origin, so the SPA at jobs.mehyar.us was blocked by the
// browser's preflight check. We proxy the login server-to-server from
// jobs.mehyar.us, so the browser only ever sees same-origin requests.
//
// Auth: same HMAC secret (ADMIN_SESSION_SECRET / MESC_JWT_SECRET) as
// mehyar-web, so the token signs and verifies on either app.

const SAFE_FAILURE = "Invalid credentials.";

function base64UrlEncode(value) {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}
function base64UrlEncodeBytes(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function hmacSha256(secret, value) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64UrlEncodeBytes(new Uint8Array(sig));
}
async function signToken(payload, secret) {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmacSha256(secret, encodedPayload);
  return `${encodedPayload}.${signature}`;
}
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function sanitize(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

// Token bucket rate-limit (per IP+identifier, in-memory)
const RL_BUCKETS = new Map();
function rateLimitOk(ip, key, limit, windowMs) {
  const k = `${ip}::${key}`;
  const now = Date.now();
  const arr = (RL_BUCKETS.get(k) || []).filter((ts) => now - ts < windowMs);
  if (arr.length >= limit) return false;
  arr.push(now);
  RL_BUCKETS.set(k, arr);
  return true;
}

function corsHeaders(request) {
  const origin = request.headers.get("origin");
  // Same-origin or .mehyar.us — be permissive, lock down elsewhere.
  const allowed = (origin || "").endsWith(".mehyar.us") || !origin;
  return {
    "access-control-allow-origin": allowed && origin ? origin : "https://jobs.mehyar.us",
    "vary": "Origin",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-credentials": "true",
  };
}
function json(body, status, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...corsHeaders(request) },
  });
}

export const onRequestPost = async ({ request, env }) => {
  const secret = env?.ADMIN_SESSION_SECRET || env?.MESC_JWT_SECRET || env?.HMAC_SECRET || "";
  const expectedIdentifier = (env?.MEHYARSOFT_ADMIN_USERNAME || env?.MEHYARSOFT_ADMIN_EMAIL || "").toLowerCase();
  const expectedPassword = env?.MEHYARSOFT_ADMIN_PASSWORD || "";

  if (!expectedIdentifier || !expectedPassword || !secret) {
    return json({ ok: false, message: "Admin auth is not configured." }, 503, request);
  }

  // Rate limit
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!rateLimitOk(ip, "login", 10, 15 * 60 * 1000)) {
    return json({ ok: false, message: SAFE_FAILURE }, 429, request);
  }

  let body = {};
  try { body = await request.json(); } catch { return json({ ok: false, message: SAFE_FAILURE }, 400, request); }

  const identifier = sanitize(body.username || body.email || "", 254).toLowerCase();
  const password = typeof body.password === "string" ? body.password : "";

  if (identifier !== expectedIdentifier || !timingSafeEqual(password, expectedPassword)) {
    return json({ ok: false, message: SAFE_FAILURE }, 401, request);
  }

  const expiresAtMs = Date.now() + 1000 * 60 * 60 * 8;
  const token = await signToken({ sub: identifier, exp: Math.floor(expiresAtMs / 1000) }, secret);
  return json({ token, expiresAt: new Date(expiresAtMs).toISOString() }, 200, request);
};

export const onRequestOptions = ({ request }) => {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
};
