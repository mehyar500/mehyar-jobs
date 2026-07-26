// _shared/adminAuth.js
//
// Shared session verifier for mehyar-jobs.
//
// The JWT is the same one issued by mehyar-web's /api/admin/auth/login.
// Both apps use the same HS256 secret (MESC_JWT_SECRET) so mehyar-jobs
// can verify a token issued by mehyar-web without sharing any DB or KV.
//
// Token format (from mehyar-web/functions/api/admin/auth/login.js):
//   Header: { alg: HS256, typ: JWT }
//   Payload: { sub: username, iat: <unix>, exp: <unix>, name, ts }
//   Signature: HMAC-SHA256(secret, header.payload) base64url

// Constant-time string compare
function safeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// b64url decode (no padding)
function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// HMAC-SHA256 with a Web Crypto key, returns the signature as b64url
async function hmac(secret, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return base64urlFromBytes(new Uint8Array(sig));
}

function base64urlFromBytes(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlToString(s) {
  return atob(s.replace(/-/g, "+").replace(/_/g, "/"));
}

// Parse a cookie header into a map
function parseCookies(req) {
  const header = req.headers.get("cookie") || "";
  const out = {};
  for (const part of header.split(/;\s*/)) {
    if (!part) continue;
    const i = part.indexOf("=");
    out[i === -1 ? part : part.slice(0, i)] = i === -1 ? "" : decodeURIComponent(part.slice(i + 1));
  }
  return out;
}

// Verify a token issued by mehyar-web using MESC_JWT_SECRET.
//
// mehyar-web login token shape (NOT a 3-part JWT — only 2 parts):
//   `${base64url(payload_json)} . ${base64url(HMAC-SHA256(secret, payload))}`
//   Payload: { sub: username, exp: <unix-seconds> }
//   Signature: HMAC-SHA256(secret, payload) base64url
export async function verifyToken(token, secret) {
  if (!token || typeof token !== "string") return { ok: false, message: "missing_token" };
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, message: "malformed_token" };
  const [p, sig] = parts;

  // Recompute signature
  const expect = await hmac(secret, p);
  if (!safeEq(expect, sig)) return { ok: false, message: "bad_signature" };

  // Parse + check exp
  let payload;
  try { payload = JSON.parse(b64urlToString(p)); } catch { return { ok: false, message: "bad_payload" }; }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && now > payload.exp) {
    return { ok: false, message: "expired" };
  }
  return { ok: true, payload };
}

// Authorization helper: pulls bearer from header OR admin_session cookie,
// verifies, and returns the principal or a 401 response.
export async function requireAdmin(request, env) {
  const authHeader = request.headers.get("authorization") || "";
  let token = "";
  if (authHeader.toLowerCase().startsWith("bearer ")) token = authHeader.slice(7).trim();

  if (!token) {
    const cookies = parseCookies(request);
    token = cookies.admin_session || "";
  }

  const secret = env?.MESC_JWT_SECRET || env?.ADMIN_JWT_SECRET || "";
  if (!secret) return { ok: false, status: 500, message: "auth_secret_unconfigured" };

  const result = await verifyToken(token, secret);
  if (!result.ok) return { ok: false, status: 401, message: result.message };
  return { ok: true, principal: result.payload };
}

// CORS headers for browser preflight + credentialed requests.
// We accept the mehyar.us family so cross-app SSO works smoothly.
export function corsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  const allowed = [
    "https://mehyar.us",
    "https://www.mehyar.us",
    "https://jobs.mehyar.us",
    "https://api.mehyar.us",
    "http://localhost:5173",
    "http://localhost:4173",
  ];
  const allow = allowed.includes(origin) ? origin : (env?.APP_HOST || "https://jobs.mehyar.us");
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-requested-with",
    "access-control-max-age": "86400",
    "vary": "Origin",
  };
}

export function json(body, status = 200, request, env, extra = {}) {
  const headers = {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...corsHeaders(request || { headers: { get: () => "" } }, env || {}),
    ...extra,
  };
  return new Response(JSON.stringify(body), { status, headers });
}

// OPTIONS preflight handler factory
export async function onRequestOptions({ request, env }) {
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}