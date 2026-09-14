// _shared/anonGate.js
//
// Anonymous free-funnel gating. Visitors without an account get one free
// resume check (ever) plus a small daily allowance of AI generations
// (tailored resume / cover letter), keyed by a salted SHA-256 hash of
// their IP. No raw IPs are stored.

function pepper(env) {
  return env?.ADMIN_SESSION_SECRET || env?.MESC_JWT_SECRET || env?.HMAC_SECRET || "mehyar-jobs-anon";
}

export function clientIp(request) {
  const cf = (request.headers.get("cf-connecting-ip") || "").trim();
  if (cf) return cf;
  const xff = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  return xff || "unknown";
}

export async function clientIpHash(request, env) {
  const data = new TextEncoder().encode(`${clientIp(request)}::${pepper(env)}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// kind: 'check' | 'ai'  — opts: { ever: n, perDay: n }
// Returns { allowed, usedEver, usedToday }.
export async function anonUsage(db, ipHash, kind) {
  const ever = await db.prepare(
    "SELECT COUNT(*) AS n FROM anon_free_run WHERE ip_hash = ? AND kind = ?"
  ).bind(ipHash, kind).first().catch(() => ({ n: 0 }));
  const today = await db.prepare(
    "SELECT COUNT(*) AS n FROM anon_free_run WHERE ip_hash = ? AND kind = ? AND date(created_at) = date('now')"
  ).bind(ipHash, kind).first().catch(() => ({ n: 0 }));
  return { usedEver: Number(ever?.n || 0), usedToday: Number(today?.n || 0) };
}

export async function recordAnonUse(db, ipHash, kind) {
  await db.prepare(
    "INSERT INTO anon_free_run (ip_hash, kind) VALUES (?, ?)"
  ).bind(ipHash, kind).run().catch(() => null);
}
