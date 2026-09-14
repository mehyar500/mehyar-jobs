// scanner-worker/src/studio.js
//
// Free-funnel AI studio endpoints (Workers AI):
//   POST /tailor        — rewrite the visitor's resume into a polished,
//                         tailored resume (+ concrete improvements).
//   POST /cover-letter  — draft a cover letter for a specific job.
//
// Auth is OPTIONAL: a valid member Bearer <redacted> gets a generous daily
// allowance; anonymous visitors are gated by salted IP hash (3 AI
// generations/day). Everything is free — the funnel, not a paywall.

import { requireUser } from "../../functions/_shared/userAuth.js";
import { ensureSchema } from "../../functions/_shared/db.js";
import { deriveProfileFromResume } from "../../functions/_shared/userAuth.js";
import { generateCoverLetter } from "../../functions/_shared/coverLetter.js";
import { clientIpHash, anonUsage, recordAnonUse } from "../../functions/_shared/anonGate.js";

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";
const MAX_RESUME_CHARS = 12000;
const MEMBER_AI_PER_DAY = 20;
const ANON_AI_PER_DAY = 3;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function corsJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// Resolve identity: member token wins; otherwise anonymous IP gate.
// Returns { ok, user, gateKey, limit } or { ok:false, status, message }.
async function resolveIdentity(request, env) {
  await ensureSchema(env);
  const db = env.JOBS_DB;
  const auth = await requireUser(request, env).catch(() => ({ ok: false }));
  if (auth?.ok && auth.user) {
    const key = `user:${auth.user.id}`;
    const usage = await anonUsage(db, key, "ai");
    if (usage.usedToday >= MEMBER_AI_PER_DAY) {
      return { ok: false, status: 429, message: "Daily AI limit reached — try again tomorrow." };
    }
    return { ok: true, user: auth.user, gateKey: key, limit: MEMBER_AI_PER_DAY, remaining: MEMBER_AI_PER_DAY - usage.usedToday };
  }
  const ipHash = await clientIpHash(request, env);
  const usage = await anonUsage(db, ipHash, "ai");
  if (usage.usedToday >= ANON_AI_PER_DAY) {
    return {
      ok: false, status: 429,
      message: "You've used today's free AI generations. Create a free account for a bigger daily allowance.",
      error: "anon_ai_limit",
    };
  }
  return { ok: true, user: null, gateKey: ipHash, limit: ANON_AI_PER_DAY, remaining: ANON_AI_PER_DAY - usage.usedToday };
}

async function getResumeText(body, identity, env) {
  let text = String(body.resume_text || "").slice(0, MAX_RESUME_CHARS);
  if (!text.trim() && identity.user) {
    const row = await env.JOBS_DB.prepare(
      "SELECT text FROM user_resume WHERE user_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 1"
    ).bind(identity.user.id).first().catch(() => null);
    if (row?.text) text = String(row.text).slice(0, MAX_RESUME_CHARS);
  }
  return text;
}

function extractJson(text) {
  let t = String(text || "").replace(/```(?:json)?/gi, "").trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// ── POST /tailor ──────────────────────────────────────────────────────
function tailorPrompt(resumeText, targetRole, job) {
  const target = [];
  if (targetRole) target.push(`Target role: ${targetRole}`);
  if (job?.title) target.push(`Target job: ${job.title}${job.company ? ` at ${job.company}` : ""}`);
  if (job?.description) target.push(`Job description:\n${String(job.description).slice(0, 2500)}`);
  return [
    "You are an expert resume writer. Rewrite the resume below into a polished, ATS-friendly, tailored resume as plain text.",
    "",
    "Rules:",
    "- Keep every fact truthful: do NOT invent employers, dates, degrees, or metrics. You may rephrase and reorganize, and you may strengthen weak bullets by making existing achievements concrete — but never fabricate.",
    "- Lead with a 2-3 line professional summary tailored to the target.",
    "- Use strong action verbs; quantify wherever the original gives numbers.",
    "- Skills section grouped by category, mirroring keywords from the target role/job when the candidate genuinely has them.",
    "- Section headings in ALL CAPS on their own lines (SUMMARY, SKILLS, EXPERIENCE, EDUCATION). Keep the resume under ~4000 characters.",
    target.length ? "- Tailor specifically for:\n" + target.map((t) => "  " + t).join("\n") : "- Tailor for the candidate's strongest role family.",
    "",
    "After the resume, add a line containing exactly ---IMPROVEMENTS--- and then up to 5 bullet lines, each starting with '- '.",
    "Each bullet must name a SPECIFIC EDIT to make to the resume above and why it helps — e.g. '- Move the 30% fraud-loss figure into the Fintech Corp bullet: quantified impact beats duty descriptions'.",
    "Never invent new achievements, metrics, or employers in the improvements; only suggest edits grounded in the original resume.",
    "Output the resume, the delimiter line, and the bullets — nothing else. No intro, no outro, no code fences.",
    "",
    "Original resume:",
    resumeText,
  ].join("\n");
}

// Split "resume \n ---IMPROVEMENTS--- \n - ..." into parts.
function splitTailor(text) {
  const t = String(text || "").replace(/```/g, "").trim();
  const marker = "---IMPROVEMENTS---";
  const idx = t.indexOf(marker);
  if (idx === -1) return { resume: t, improvements: [] };
  const resume = t.slice(0, idx).trim();
  const improvements = t
    .slice(idx + marker.length)
    .split("\n")
    .map((l) => l.replace(/^[-*\u2022\d.)\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 6);
  return { resume, improvements };
}

export async function handleTailor(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return corsJson({ ok: false, error: "method_not_allowed" }, 405);
  if (!env.AI || typeof env.AI.run !== "function") return corsJson({ ok: false, error: "ai_unavailable" }, 503);

  const identity = await resolveIdentity(request, env);
  if (!identity.ok) return corsJson({ ok: false, error: identity.error || "limit", message: identity.message }, identity.status);

  let body = {};
  try { body = await request.json(); } catch { /* fall through */ }
  const text = await getResumeText(body, identity, env);
  if (text.trim().length < 200) return corsJson({ ok: false, error: "resume_too_short" }, 400);

  const targetRole = String(body.target_role || "").slice(0, 80) || null;
  const job = body.job && typeof body.job === "object"
    ? { title: String(body.job.title || "").slice(0, 120), company: String(body.job.company || "").slice(0, 120), description: String(body.job.description || "").slice(0, 2500) }
    : null;

  let raw;
  try {
    const ai = await env.AI.run(MODEL, { prompt: tailorPrompt(text, targetRole, job), max_tokens: 3000 });
    raw = ai?.response;
  } catch (e) {
    console.error(JSON.stringify({ event: "tailor_ai_error", error: String(e?.message || e).slice(0, 200) }));
    return corsJson({ ok: false, error: "ai_error" }, 502);
  }
  const { resume, improvements } = splitTailor(raw);
  if (resume.trim().length < 100) return corsJson({ ok: false, error: "ai_empty" }, 502);

  await recordAnonUse(env.JOBS_DB, identity.gateKey, "ai");
  return corsJson({
    ok: true,
    tailored_resume: resume.slice(0, 8000),
    improvements: improvements.map((x) => String(x).slice(0, 300)),
    ai_remaining: Math.max(0, identity.remaining - 1),
  });
}

// ── POST /cover-letter ────────────────────────────────────────────────
function coverLetterPrompt(resumeText, job) {
  return [
    "You are an expert career coach. Write a short, specific cover letter (under 220 words) for the job below, based on the candidate's resume.",
    "",
    "Rules:",
    "- Open with the exact role + company and ONE concrete reason the candidate fits (a matching skill or achievement from the resume).",
    "- Reference 1-2 specific facts from the job description and tie them to the candidate's real experience.",
    "- No clichés: never write 'I am writing to express my interest', 'I am confident I would be a great fit', 'Thank you for your consideration', or 'passionate' filler.",
    "- Plain, confident tone. Sign off with a simple name placeholder [Your Name].",
    "",
    "Output ONLY the cover letter text — paragraphs separated by blank lines. No JSON, no intro, no code fences.",
    "",
    `Job: ${job.title}${job.company ? ` at ${job.company}` : ""}`,
    job.location ? `Location: ${job.location}` : "",
    job.description ? `Description:\n${String(job.description).slice(0, 2500)}` : "",
    "",
    "Resume:",
    resumeText,
  ].join("\n");
}

export async function handleCoverLetter(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return corsJson({ ok: false, error: "method_not_allowed" }, 405);
  if (!env.AI || typeof env.AI.run !== "function") return corsJson({ ok: false, error: "ai_unavailable" }, 503);

  const identity = await resolveIdentity(request, env);
  if (!identity.ok) return corsJson({ ok: false, error: identity.error || "limit", message: identity.message }, identity.status);

  let body = {};
  try { body = await request.json(); } catch { /* fall through */ }

  // Resolve the job: by id from the DB, or explicit fields.
  let job = null;
  const jobId = parseInt(body.job_id, 10);
  if (jobId) {
    const row = await env.JOBS_DB.prepare(`
      SELECT j.title, j.location, j.description_text, c.name AS company
      FROM job j JOIN company c ON c.id = j.company_id
      WHERE j.id = ? AND j.is_active = 1
    `).bind(jobId).first().catch(() => null);
    if (row) job = { title: row.title, company: row.company, location: row.location, description: row.description_text };
  }
  if (!job && body.job && typeof body.job === "object" && body.job.title) {
    job = {
      title: String(body.job.title).slice(0, 120),
      company: String(body.job.company || "").slice(0, 120),
      location: String(body.job.location || "").slice(0, 120),
      description: String(body.job.description || "").slice(0, 2500),
    };
  }
  if (!job?.title) return corsJson({ ok: false, error: "job_required", message: "Pick one of your matched jobs first." }, 400);

  const text = await getResumeText(body, identity, env);
  if (text.trim().length < 200) return corsJson({ ok: false, error: "resume_too_short" }, 400);

  // Deterministic draft first (always specific, never generic).
  let profile = null;
  try { profile = deriveProfileFromResume(text, {}); } catch { /* ignore */ }
  let fallback = null;
  try {
    fallback = generateCoverLetter({ profile: profile || {}, job: { title: job.title, description_text: job.description }, company: { name: job.company } });
  } catch { /* ignore */ }

  let letter = null;
  try {
    const ai = await env.AI.run(MODEL, { prompt: coverLetterPrompt(text, job), max_tokens: 900 });
    const raw = String(ai?.response || "").replace(/```/g, "").trim();
    if (raw.length > 40) letter = raw;
  } catch (e) {
    console.error(JSON.stringify({ event: "cover_ai_error", error: String(e?.message || e).slice(0, 200) }));
  }

  await recordAnonUse(env.JOBS_DB, identity.gateKey, "ai");
  return corsJson({
    ok: true,
    job: { title: job.title, company: job.company },
    cover_letter: letter ? String(letter).slice(0, 4000) : (fallback || ""),
    ai_drafted: Boolean(letter),
    ai_remaining: Math.max(0, identity.remaining - 1),
  });
}
