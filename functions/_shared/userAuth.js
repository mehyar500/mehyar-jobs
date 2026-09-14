// _shared/userAuth.js
//
// Public multi-user auth for mehyar.jobs.
//
// Two credential families share one token format (the same 2-part
// `base64url(payload).base64url(HMAC-SHA256(secret, payload))` shape that
// mehyar-web and /api/auth/login use, verified by verifyToken):
//
//   1. Owner (admin) — logs in exactly as today via /api/auth/login with
//      the MEHYARSOFT_ADMIN_USERNAME / MEHYARSOFT_ADMIN_PASSWORD env pair.
//      requireUser() maps that token's `sub` onto the seeded owner
//      app_user row, so the owner gets "the same login" plus a real
//      account holding his resume.
//   2. Public users — sign up with email + password at /api/auth/signup
//      (newsletter opt-in is mandatory: it is the price of a run) and
//      sign back in at /api/auth/user-login. Passwords are PBKDF2-SHA256.
//
// ensureOwnerAccount(env) is idempotent: it creates the owner's account
// the first time it runs and migrates his resume + fit profile out of the
// legacy single-row `profile` table into user_resume / user_profile.

import { verifyToken, json, corsHeaders, onRequestOptions } from "./adminAuth.js";

export { onRequestOptions };

// ── base64url helpers ──────────────────────────────────────────────
function b64urlEncodeBytes(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecodeToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function hmacSign(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64urlEncodeBytes(new Uint8Array(sig));
}
function safeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function getSecret(env) {
  return env?.ADMIN_SESSION_SECRET || env?.MESC_JWT_SECRET || env?.HMAC_SECRET || "";
}

export async function signUserToken(userId, env, ttlSeconds = 30 * 24 * 3600) {
  const secret = getSecret(env);
  if (!secret) throw new Error("auth_not_configured");
  const now = Math.floor(Date.now() / 1000);
  const payload = b64urlEncodeBytes(new TextEncoder().encode(JSON.stringify({
    sub: `user:${userId}`, iat: now, exp: now + ttlSeconds,
  })));
  const sig = await hmacSign(secret, payload);
  return `${payload}.${sig}`;
}

// ── passwords: PBKDF2-SHA256 ───────────────────────────────────────
// Cloudflare Workers caps PBKDF2 at 100,000 iterations — stay at the cap.
const PBKDF2_ITER = 100000;
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITER }, key, 256
  );
  return `pbkdf2-sha256$${PBKDF2_ITER}$${b64urlEncodeBytes(salt)}$${b64urlEncodeBytes(new Uint8Array(bits))}`;
}
export async function verifyPassword(password, stored) {
  try {
    if (!stored || typeof stored !== "string") return false;
    if (stored === "env-admin") return false; // owner authenticates via admin env login
    const [algo, iterS, saltB64, hashB64] = stored.split("$");
    if (algo !== "pbkdf2-sha256") return false;
    const iterations = parseInt(iterS, 10);
    if (!iterations || iterations < 10000) return false;
    const salt = b64urlDecodeToBytes(saltB64);
    const expected = b64urlDecodeToBytes(hashB64);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = new Uint8Array(await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, expected.length * 8
    ));
    if (bits.length !== expected.length) return false;
    let r = 0;
    for (let i = 0; i < bits.length; i++) r |= bits[i] ^ expected[i];
    return r === 0;
  } catch { return false; }
}

// ── request helpers ────────────────────────────────────────────────
function bearerToken(request) {
  const h = request.headers.get("authorization") || "";
  if (h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  const cookie = request.headers.get("cookie") || "";
  for (const part of cookie.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (part.slice(0, i) === "user_session") return decodeURIComponent(part.slice(i + 1));
  }
  return "";
}

function sanitizeEmail(v) {
  const s = String(v || "").trim().toLowerCase().slice(0, 320);
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? s : "";
}

// Resolve a verified token to an app_user row.
// Returns { ok:true, user } or { ok:false, status, message }.
export async function requireUser(request, env) {
  const secret = getSecret(env);
  if (!secret) return { ok: false, status: 500, message: "auth_secret_unconfigured" };
  const token = bearerToken(request);
  if (!token) return { ok: false, status: 401, message: "missing_token" };
  const v = await verifyToken(token, secret);
  if (!v.ok) return { ok: false, status: 401, message: v.message };

  const sub = String(v.payload?.sub || "");
  const db = env?.JOBS_DB;
  if (!db) return { ok: false, status: 500, message: "no_db" };

  let user = null;
  if (sub.startsWith("user:")) {
    const id = parseInt(sub.slice(5), 10);
    if (id) user = await db.prepare("SELECT * FROM app_user WHERE id = ?").bind(id).first().catch(() => null);
  } else {
    // Admin/owner token (sub = username, e.g. 'mehyar500'): map to the owner account.
    const s = sub.toLowerCase();
    user = await db.prepare(
      "SELECT * FROM app_user WHERE lower(username) = ? OR lower(email) = ?"
    ).bind(s, s).first().catch(() => null);
  }
  if (!user) return { ok: false, status: 401, message: "unknown_account" };
  return { ok: true, user };
}

export function isOwnerTokenUser(user) {
  return !!(user && (user.is_admin === 1 || String(user.username || "").toLowerCase() === "mehyar500"));
}

// ── job-alert one-click off tokens ─────────────────────────────────────
// "Turn off this alert" links in alert emails. Signed with the same HMAC
// secret; no login required. Payload binds alert id + owner user id.
export async function signAlertToken(alertId, userId, env) {
  const secret = getSecret(env);
  if (!secret) throw new Error("auth_not_configured");
  const payload = b64urlEncodeBytes(new TextEncoder().encode(JSON.stringify({ a: Number(alertId), u: Number(userId) })));
  const sig = await hmacSign(secret, `alertoff:${payload}`);
  return `${payload}.${sig}`;
}

export async function verifyAlertToken(token, env) {
  try {
    const secret = getSecret(env);
    if (!secret || !token || typeof token !== "string") return null;
    const [payload, sig] = token.split(".");
    if (!payload || !sig) return null;
    const expect = await hmacSign(secret, `alertoff:${payload}`);
    if (!safeEq(sig, expect)) return null;
    const data = JSON.parse(new TextDecoder().decode(b64urlDecodeToBytes(payload)));
    const a = Number(data?.a), u = Number(data?.u);
    return Number.isFinite(a) && a > 0 && Number.isFinite(u) && u > 0 ? { alertId: a, userId: u } : null;
  } catch { return null; }
}

// ── newsletter unsubscribe tokens ────────────────────────────────────
// One-click unsubscribe links for digest/welcome emails. Signed with the
// same HMAC secret as session tokens; no login required to use one.
export async function signUnsubscribeToken(email, env, brand = "mehyar.jobs") {
  const secret = getSecret(env);
  if (!secret) throw new Error("auth_not_configured");
  const em = String(email || "").trim().toLowerCase();
  const br = String(brand || "mehyar.jobs").trim().toLowerCase();
  const payload = b64urlEncodeBytes(new TextEncoder().encode(JSON.stringify({ em, br })));
  const sig = await hmacSign(secret, `unsub:${payload}`);
  return `${payload}.${sig}`;
}

export async function verifyUnsubscribeToken(token, env) {
  try {
    const secret = getSecret(env);
    if (!secret || !token || typeof token !== "string") return null;
    const [payload, sig] = token.split(".");
    if (!payload || !sig) return null;
    const expect = await hmacSign(secret, `unsub:${payload}`);
    if (!safeEq(sig, expect)) return null;
    const data = JSON.parse(new TextDecoder().decode(b64urlDecodeToBytes(payload)));
    const em = String(data?.em || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)) return null;
    // Legacy tokens carry no brand -> null means "all brands".
    const br = String(data?.br || "").trim().toLowerCase() || null;
    return { email: em, brand: br };
  } catch { return null; }
}

// ── preference-page tokens ─────────────────────────────────────────
// Signed /pref/<token> URLs for the explicit-preference landing page.
// HMAC `pref:` prefix + expiry (default 90 days). Carries the contact's
// email only — no login required, but tampered or expired tokens are
// rejected outright.
export const PREF_TOKEN_TTL_SECONDS = 90 * 24 * 3600;

export async function signPrefToken(email, env, ttlSeconds = PREF_TOKEN_TTL_SECONDS) {
  const secret = getSecret(env);
  if (!secret) throw new Error("auth_not_configured");
  const em = String(email || "").trim().toLowerCase();
  const exp = Math.floor(Date.now() / 1000) + Number(ttlSeconds);
  const payload = b64urlEncodeBytes(new TextEncoder().encode(JSON.stringify({ em, exp, v: 1 })));
  const sig = await hmacSign(secret, `pref:${payload}`);
  return `${payload}.${sig}`;
}

export async function verifyPrefToken(token, env) {
  try {
    const secret = getSecret(env);
    if (!secret || !token || typeof token !== "string") return null;
    const [payload, sig] = token.split(".");
    if (!payload || !sig) return null;
    const expect = await hmacSign(secret, `pref:${payload}`);
    if (!safeEq(sig, expect)) return null;
    const data = JSON.parse(new TextDecoder().decode(b64urlDecodeToBytes(payload)));
    const em = String(data?.em || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)) return null;
    const exp = Number(data?.exp);
    if (!Number.isFinite(exp) || Math.floor(Date.now() / 1000) > exp) return null;
    return em;
  } catch { return null; }
}

// ── owner seeding + legacy profile migration ───────────────────────
// Idempotent. Called from ensureSchema() so it runs wherever the DB is touched.
export async function ensureOwnerAccount(env) {
  const db = env?.JOBS_DB;
  if (!db) return null;
  const ownerEmail = String(env?.NOTIFY_EMAIL || "mrswelim@gmail.com").toLowerCase();
  const ownerUsername = env?.MEHYARSOFT_ADMIN_USERNAME || "Mehyar500";

  let user = await db.prepare(
    "SELECT * FROM app_user WHERE lower(username) = 'mehyar500' OR lower(email) = ?"
  ).bind(ownerEmail).first().catch(() => null);

  if (!user) {
    const r = await db.prepare(`
      INSERT INTO app_user (username, email, password_hash, display_name, is_admin, newsletter_opt_in)
      VALUES (?, ?, 'env-admin', 'Mehyar Swellem', 1, 1)
    `).bind(ownerUsername, ownerEmail).run().catch(() => null);
    const id = r?.meta?.last_row_id;
    if (!id) return null;
    user = await db.prepare("SELECT * FROM app_user WHERE id = ?").bind(id).first().catch(() => null);
    if (!user) return null;
  }

  // Migrate the legacy single-row profile (id = 1) exactly once.
  const hasResume = await db.prepare("SELECT 1 AS x FROM user_resume WHERE user_id = ? LIMIT 1").bind(user.id).first().catch(() => null);
  const hasProfile = await db.prepare("SELECT 1 AS x FROM user_profile WHERE user_id = ? LIMIT 1").bind(user.id).first().catch(() => null);
  if (!hasResume || !hasProfile) {
    const legacy = await db.prepare("SELECT * FROM profile WHERE id = 1").first().catch(() => null);
    if (legacy) {
      if (!hasResume && (legacy.resume_text || legacy.resume_base64)) {
        await db.prepare(`
          INSERT INTO user_resume (user_id, filename, mime, base64, text, is_active)
          VALUES (?, ?, ?, ?, ?, 1)
        `).bind(
          user.id,
          legacy.resume_filename || "resume.pdf",
          legacy.resume_mime || "application/pdf",
          legacy.resume_base64 || null,
          legacy.resume_text || null
        ).run().catch(() => null);
      }
      if (!hasProfile) {
        await db.prepare(`
          INSERT OR IGNORE INTO user_profile
            (user_id, target_titles_json, keywords_json, exclude_keywords_json, locations_json,
             remote_required, min_salary_usd, preferred_industries_json, excluded_industries_json, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          user.id,
          legacy.target_titles_json || "[]",
          legacy.keywords_json || "[]",
          legacy.exclude_keywords_json || "[]",
          legacy.locations_json || "[]",
          legacy.remote_required ? 1 : 0,
          legacy.min_salary_usd ?? null,
          legacy.preferred_industries_json || "[]",
          legacy.excluded_industries_json || "[]",
          legacy.notes || null
        ).run().catch(() => null);
      }
    } else if (!hasProfile) {
      await db.prepare("INSERT OR IGNORE INTO user_profile (user_id) VALUES (?)").bind(user.id).run().catch(() => null);
    }
  }
  return user;
}

// ── resume → profile derivation ────────────────────────────────────
// Turns free-form resume text into a first-pass fit profile so a brand-new
// user gets meaningful matches without hand-tuning keywords.
const STOPWORDS = new Set(("a,an,the,and,or,of,to,in,on,for,with,at,by,from,as,is,are,was,were,be,been,have,has,had,do,does,did,will,would,can,could,should,may,might,this,that,these,those,it,its,i,me,my,we,our,you,your,he,she,they,their,not,no,yes,if,then,than,so,such,into,over,under,between,through,during,including,etc,via,per,within,across,using,used,use,based,including,driven,led,lead,managed,built,developed,designed,implemented,created,improved,increased,reduced,experience,experienced,skills,summary,objective,education,work,history,employment,responsibilities,responsible,including,various,multiple,team,collaborated,collaboration,strong,proven,ability,abilities,excellent,highly,detail,oriented,results,passionate,dedicated,seeking,looking,role,position,company,year,years,present,including,job").split(","));

function topTerms(text, limit) {
  const counts = new Map();
  for (const raw of String(text || "").toLowerCase().split(/[^a-z0-9+#.\-]{1,}/)) {
    const t = raw.replace(/^[#.\-]+|[#.\-]+$/g, "");
    if (t.length < 3 || t.length > 30 || STOPWORDS.has(t) || /^\d+$/.test(t)) continue;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([t]) => t);
}

const TITLE_HINTS = [
  "engineer", "developer", "designer", "manager", "director", "analyst", "scientist",
  "nurse", "doctor", "physician", "teacher", "professor", "accountant", "auditor",
  "lawyer", "attorney", "paralegal", "chef", "cook", "server", "bartender",
  "driver", "pilot", "technician", "mechanic", "electrician", "plumber", "carpenter",
  "sales", "marketing", "recruiter", "hr", "consultant", "advisor", "agent",
  "representative", "specialist", "coordinator", "administrator", "assistant",
  "clerk", "cashier", "associate", "supervisor", "lead", "architect", "writer",
  "editor", "photographer", "videographer", "therapist", "pharmacist", "dentist",
];

function titleCase(s) {
  return String(s || "").toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// Words that are never part of a job title — stripped from the front of a guess.
const TITLE_LEAD_STOP = new Set(("a,an,the,as,of,for,with,at,by,from,to,in,on,and,or,my,our,current,former,seeking,looking,experienced,senior-level").split(","));

function guessTitles(text) {
  const found = [];
  const push = (t) => {
    t = String(t || "").replace(/\s+/g, " ").trim().replace(/[,.;:!?()"\-]+$/g, "").trim();
    if (t && t.length <= 80 && !found.some((f) => f.toLowerCase() === t.toLowerCase())) found.push(t);
  };
  const raw = String(text || "");
  // Pass 1: short lines that look like titles (structured resumes).
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 12);
  for (const line of lines) {
    if (line.length > 80) continue;
    if (TITLE_HINTS.some((h) => line.toLowerCase().includes(h))) push(line);
    if (found.length >= 3) return found;
  }
  if (found.length) return found;
  // Pass 2: blob text (no line breaks) — find a hint word and capture the
  // couple of words before it, e.g. "Senior Software Engineer with 8 years…"
  // → "Senior Software Engineer".
  const words = raw.split(/\s+/).filter(Boolean);
  const clean = words.map((w) => w.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""));
  for (let i = 0; i < clean.length && found.length < 3; i++) {
    let w = clean[i];
    if (!TITLE_HINTS.includes(w)) {
      const singular = w.replace(/(es|s)$/, "");
      if (!TITLE_HINTS.includes(singular)) continue;
      w = singular;
    }
    const win = [];
    for (let j = i; j >= Math.max(0, i - 3) && win.length < 4; j--) {
      if (j < i && /[.!?;:,"“”‘’]/.test(words[j])) break; // stop at sentence/clause boundary
      const cw = clean[j];
      if (j < i && (TITLE_LEAD_STOP.has(cw) || /^\d+$/.test(cw))) break;
      const orig = words[j].replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
      // Title words are capitalized in prose ("Senior Software Engineer");
      // skip lowercase mentions ("mentored 5 junior engineers").
      if (orig && orig[0] !== orig[0].toUpperCase()) break;
      if (orig) win.unshift(orig);
    }
    if (win.length) push(titleCase(win.filter(Boolean).join(" ")));
  }
  return found;
}

export function deriveProfileFromResume(text, hints = {}) {
  const keywords = topTerms(text, 25);
  let target_titles = Array.isArray(hints.target_titles) && hints.target_titles.length
    ? hints.target_titles.slice(0, 5)
    : guessTitles(text);
  if (hints.current_title && !target_titles.includes(hints.current_title)) {
    target_titles = [hints.current_title, ...target_titles].slice(0, 5);
  }
  const locations = Array.isArray(hints.locations) && hints.locations.length ? hints.locations.slice(0, 5) : [];
  return { target_titles, keywords, locations };
}

// Load a user's fit profile in the exact shape fit.js loadProfile() returns,
// so scoreJob() works unchanged for public users.
export async function getUserFitProfile(env, userId) {
  const db = env.JOBS_DB;
  const row = await db.prepare("SELECT * FROM user_profile WHERE user_id = ?").bind(userId).first().catch(() => null);
  const resume = await db.prepare("SELECT text FROM user_resume WHERE user_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 1").bind(userId).first().catch(() => null);
  const safeJson = (v, d) => { try { const p = JSON.parse(v); return Array.isArray(p) ? p : d; } catch { return d; } };
  return {
    full_name: "",
    email: "",
    target_titles: safeJson(row?.target_titles_json, []),
    keywords: safeJson(row?.keywords_json, []),
    exclude_keywords: safeJson(row?.exclude_keywords_json, []),
    locations: safeJson(row?.locations_json, []),
    remote_required: !!row?.remote_required,
    min_salary_usd: row?.min_salary_usd || null,
    preferred_industries: safeJson(row?.preferred_industries_json, []),
    excluded_industries: safeJson(row?.excluded_industries_json, []),
    notes: row?.notes || "",
    resume_text: resume?.text || "",
  };
}

export { json, corsHeaders };
