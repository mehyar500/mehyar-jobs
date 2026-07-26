// CF Worker — outbound email sender.
// Receives HTTP POST { to, subject, text, html } and sends via the
// send_email binding. Deployed separately because send_email bindings
// are not supported in Pages projects (only in Workers).
//
// Auth: same HMAC JWT as the rest of mehyar.jobs (MESC_JWT_SECRET).
// Endpoint: POST https://mehyar-jobs-email-sender.mehyar.workers.dev/send
//
// Bound to the email-send binding (allowed_destination_addresses =
// ["mrswelim@gmail.com", "mehyar500@gmail.com"]).

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405, headers: corsHeaders(request) });
    }

    // Auth
    const auth = request.headers.get("authorization") || "";
    const token = auth.replace(/^Bearer\s+/, "");
    if (!token) {
      return new Response(JSON.stringify({ ok: false, error: "no_token" }), { status: 401, headers: { "content-type": "application/json", ...corsHeaders(request) } });
    }
    const secret = env.MESC_JWT_SECRET || env.ADMIN_SESSION_SECRET || "";
    if (!secret) {
      return new Response(JSON.stringify({ ok: false, error: "no_secret" }), { status: 500, headers: { "content-type": "application/json", ...corsHeaders(request) } });
    }
    const v = await verifyToken(token, secret);
    if (!v.ok) {
      return new Response(JSON.stringify({ ok: false, error: v.message || "bad_token" }), { status: 401, headers: { "content-type": "application/json", ...corsHeaders(request) } });
    }

    let body = {};
    try { body = await request.json(); } catch {
      return new Response(JSON.stringify({ ok: false, error: "bad_json" }), { status: 400, headers: { "content-type": "application/json", ...corsHeaders(request) } });
    }

    const to = String(body.to || "").trim();
    const subject = String(body.subject || "").slice(0, 300);
    const text = String(body.text || "").slice(0, 50_000);
    const html = String(body.html || "").slice(0, 200_000);
    const from = String(body.from || env.FROM_EMAIL || "mehyar.jobs <noreply@mehyar.us>");

    if (!to || !subject) {
      return new Response(JSON.stringify({ ok: false, error: "to_and_subject_required" }), { status: 400, headers: { "content-type": "application/json", ...corsHeaders(request) } });
    }

    try {
      const r = await env.SEND_EMAIL.send({ from, to, subject, text, html });
      return new Response(JSON.stringify({ ok: true, id: r?.id || null }), { status: 200, headers: { "content-type": "application/json", ...corsHeaders(request) } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }), { status: 500, headers: { "content-type": "application/json", ...corsHeaders(request) } });
    }
  },
};

function corsHeaders(request) {
  const origin = request.headers.get("origin") || "";
  const allowed = (origin.endsWith(".mehyar.us") || origin.endsWith(".pages.dev") || origin.includes("localhost")) ? origin : "https://jobs.mehyar.us";
  return {
    "access-control-allow-origin": allowed,
    "vary": "Origin",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-max-age": "86400",
  };
}

// ── 2-part token verifier (same shape as the rest of mehyar) ──
async function verifyToken(token, secret) {
  if (!token || typeof token !== "string") return { ok: false, message: "missing_token" };
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, message: "malformed_token" };
  const [p, sig] = parts;
  const expect = await hmac(secret, p);
  if (!safeEq(expect, sig)) return { ok: false, message: "bad_signature" };
  let payload;
  try { payload = JSON.parse(b64urlToString(p)); } catch { return { ok: false, message: "bad_payload" }; }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && now > payload.exp) return { ok: false, message: "expired" };
  return { ok: true, payload };
}
async function hmac(secret, value) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return b64url(new Uint8Array(sig));
}
function b64url(bytes) {
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToString(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return atob(s);
}
function safeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
