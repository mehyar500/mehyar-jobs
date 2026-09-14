// scanner-worker/src/atsMirror.js
//
// POST /ats-mirror — the ATS Mirror: "see your resume the way the robots see it."
// A deep, structured ATS audit (parseability, keywords vs target role,
// quantified impact, format killers, section architecture) plus a fully
// rewritten ATS-safe version of the resume, both from Workers AI.
//
// Auth is OPTIONAL: members get 10 mirrors/day, anonymous guests get 1 free
// mirror ever (salted IP hash via anonGate). Everything is free — limits
// exist only to prevent abuse.

import { requireUser } from "../../functions/_shared/userAuth.js";
import { ensureSchema } from "../../functions/_shared/db.js";
import { clientIpHash, anonUsage, recordAnonUse } from "../../functions/_shared/anonGate.js";

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";
const MAX_RESUME_CHARS = 12000;
const MEMBER_MIRROR_PER_DAY = 10;

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

async function resolveMirrorIdentity(request, env) {
  await ensureSchema(env);
  const db = env.JOBS_DB;
  const auth = await requireUser(request, env).catch(() => ({ ok: false }));
  if (auth?.ok && auth.user) {
    const key = `user:${auth.user.id}`;
    const usage = await anonUsage(db, key, "ats");
    if (usage.usedToday >= MEMBER_MIRROR_PER_DAY) {
      return { ok: false, status: 429, error: "mirror_limit", message: "You've used your 10 ATS mirrors for today — back tomorrow." };
    }
    return { ok: true, user: auth.user, gateKey: key, member: true, remaining: MEMBER_MIRROR_PER_DAY - usage.usedToday };
  }
  const ipHash = await clientIpHash(request, env);
  const usage = await anonUsage(db, ipHash, "ats");
  if (usage.usedEver >= 1) {
    return {
      ok: false, status: 429, error: "mirror_limit",
      message: "You've used your free ATS mirror — create a free account for 10 mirrors a day.",
    };
  }
  return { ok: true, user: null, gateKey: ipHash, member: false, remaining: 1 };
}

const AUDIT_SYSTEM = [
  "You are an ATS (Applicant Tracking System) simulation engine fused with an executive resume strategist.",
  "You have parsed millions of resumes through Workday, Taleo, Greenhouse, Lever, and iCIMS. You know exactly",
  "what makes a resume machine-readable, keyword-rich, and interview-winning — and what gets it silently discarded.",
  "",
  "AUDIT DIMENSIONS (score each 0-100 and weigh them into the overall score):",
  "1. PARSEABILITY — Can a parser cleanly extract name, contact, and sections? Garbled text, missing section headers,",
  "   or jumbled ordering kills this. If the extracted text itself looks broken, say so and penalize hard.",
  "2. CONTACT COMPLETENESS — Email, phone, city/state, LinkedIn URL. Missing pieces cost points.",
  "3. KEYWORD COVERAGE — Against the TARGET ROLE (given below; if none, infer the most likely role from the resume).",
  "   List hard skills, tools, and domain terms the role demands that are absent.",
  "4. QUANTIFIED IMPACT — What fraction of experience bullets carry numbers ($, %, time, scale)? Estimate honestly.",
  "5. ACTION VERB STRENGTH — Strong verbs (built, led, shipped, drove) vs weak/passive (responsible for, helped, worked on).",
  "6. FORMAT KILLERS — From the text: signs of tables, text boxes, multi-column layouts, graphics, headers/footers,",
  "   images, or non-standard section names that confuse parsers. Warn about what you can infer; give general",
  "   ATS-safe formatting rules regardless.",
  "7. SECTION ARCHITECTURE — Presence and order of: headline/title, summary, experience, skills, education.",
  "   Recruiters and parsers both expect this order.",
  "8. LENGTH & DENSITY — 1 page (<10 yrs) or 2 pages max; fluff vs substance.",
  "9. SENIORITY SIGNAL — Is the level obvious? Title progression clear? No down-leveling language.",
  "",
  "Return ONLY valid JSON — no markdown, no commentary, no code fences — with EXACTLY these keys:",
  "{",
  '  "score": <integer 0-100 overall ATS-readiness>,',
  '  "verdict": "<one punchy sentence: what happens to this resume in a real ATS>",',
  '  "sections": [{"name": "<dimension name>", "score": <0-100>, "note": "<one-line read>"}]  (9 entries, same order as above),',
  '  "issues": [{"severity": "critical|warning|pass", "title": "<short>", "detail": "<what is wrong, 1-2 sentences>", "fix": "<exactly what to do, 1-2 sentences>"}]  (6-12 entries, most important first),',
  '  "missing_keywords": ["<skill/tool the target role needs that is absent>"]  (up to 12),',
  '  "strong_keywords": ["<terms already present that ATSs love>"]  (up to 12),',
  '  "stats": {"word_count": <int>, "bullets_total": <int>, "bullets_quantified": <int>, "weak_verb_phrases": <int>}',
  "}",
  "Score like a machine, not a cheerleader: most resumes land 35-65. 80+ requires quantified wins, dense role keywords,",
  "and flawless structure. Be specific — quote the resume's own weak phrases when you flag them.",
].join("\n");

function auditPrompt(resumeText, targetRole) {
  return (
    AUDIT_SYSTEM +
    "\n\nTARGET ROLE: " + (targetRole || "(infer from resume)") +
    "\n\nRESUME TEXT:\n" + resumeText
  );
}

const REWRITE_SYSTEM = [
  "You are an executive resume writer. Rewrite the resume below applying every fix from its ATS audit:",
  "- HONESTY IS THE HARD RULE. Never invent, infer, or embellish: no new skills, tools, languages,",
  "  certifications, companies, titles, dates, or numbers that are not stated or clearly implied in the",
  "  original. If the original says 'did various tasks', you may NOT rewrite it as 'spearheaded Java",
  "  microservices with 90% efficiency gains'. A fabricated resume gets the candidate fired — treat every",
  "  invented claim as a career-ending defect.",
  "- Where a bullet needs a metric the original lacks, write a visible placeholder the candidate fills in:",
  "  e.g. '• Shipped internal tooling adopted by [N] engineers, cutting deploy time by [X]%'.",
  "- 'KEYWORDS TO WEAVE IN WHERE TRUTHFUL' means: use a keyword ONLY if the original resume evidences it",
  "  (same skill, tool, or directly equivalent experience). Never claim a keyword the candidate never had.",
  "  Missing keywords the candidate lacks go in a final line: 'KEYWORDS TO EARN: <comma list>'.",
  "- Keep every real fact, date, company name, title, and number exactly as stated. Improve wording only.",
  "- Lead with a 2-3 line professional summary targeting the role — built ONLY from the candidate's real background.",
  "- Start every experience bullet with a strong action verb; quantify ONLY where the original gives you numbers.",
  "- Add a SKILLS section packing the role's keywords naturally — truthful ones only.",
  "- Plain-text, ATS-safe layout ONLY:",
  "  FULL NAME (caps, first line)",
  "  City, ST | email | phone | linkedin url  (one line)",
  "  blank line, then SUMMARY / EXPERIENCE / SKILLS / EDUCATION in that order, each as a caps header.",
  "- No tables, no columns, no graphics, no special characters beyond basic punctuation and | - •.",
  "Output ONLY the rewritten resume as plain text. No commentary, no headers about the rewrite itself.",
].join("\n");

function rewritePrompt(resumeText, targetRole, missingKeywords) {
  return (
    REWRITE_SYSTEM +
    "\n\nTARGET ROLE: " + (targetRole || "(infer from resume)") +
    "\nKEYWORDS TO WEAVE IN WHERE TRUTHFUL: " + (missingKeywords || []).slice(0, 12).join(", ") +
    "\n\nORIGINAL RESUME:\n" + resumeText
  );
}

function extractJson(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function sanitizeAudit(a) {
  if (!a || typeof a !== "object") return null;
  const score = Math.max(0, Math.min(100, Math.round(Number(a.score) || 0)));
  const s = (x) => String(x || "").slice(0, 220);
  const sections = Array.isArray(a.sections) ? a.sections.slice(0, 9).map((x) => ({
    name: s(x?.name).slice(0, 40) || "Unnamed",
    score: Math.max(0, Math.min(100, Math.round(Number(x?.score) || 0))),
    note: s(x?.note),
  })) : [];
  const issues = Array.isArray(a.issues) ? a.issues.slice(0, 12).map((x) => ({
    severity: ["critical", "warning", "pass"].includes(x?.severity) ? x.severity : "warning",
    title: s(x?.title).slice(0, 80),
    detail: s(x?.detail),
    fix: s(x?.fix),
  })).filter((x) => x.title) : [];
  const kw = (arr) => Array.isArray(arr) ? arr.map((x) => String(x).slice(0, 60)).filter(Boolean).slice(0, 12) : [];
  const stats = a.stats && typeof a.stats === "object" ? {
    word_count: Math.max(0, Number(a.stats.word_count) || 0),
    bullets_total: Math.max(0, Number(a.stats.bullets_total) || 0),
    bullets_quantified: Math.max(0, Number(a.stats.bullets_quantified) || 0),
    weak_verb_phrases: Math.max(0, Number(a.stats.weak_verb_phrases) || 0),
  } : { word_count: 0, bullets_total: 0, bullets_quantified: 0, weak_verb_phrases: 0 };
  return {
    score,
    verdict: s(a.verdict).slice(0, 300),
    sections, issues,
    missing_keywords: kw(a.missing_keywords),
    strong_keywords: kw(a.strong_keywords),
    stats,
  };
}

export async function handleAtsMirror(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return corsJson({ ok: false, error: "method_not_allowed" }, 405);

  if (!env.AI || typeof env.AI.run !== "function") {
    return corsJson({ ok: false, error: "ai_unavailable" }, 503);
  }

  const ident = await resolveMirrorIdentity(request, env);
  if (!ident.ok) return corsJson({ ok: false, error: ident.error, message: ident.message }, ident.status);

  let body = {};
  try { body = await request.json(); } catch { /* fall through */ }

  const text = String(body.resume_text || "").slice(0, MAX_RESUME_CHARS);
  const targetRole = String(body.target_role || "").slice(0, 120).trim();
  if (text.trim().length < 200) return corsJson({ ok: false, error: "resume_too_short" }, 400);

  // Pass 1: the deep audit.
  let audit = null;
  try {
    const out = await env.AI.run(MODEL, { prompt: auditPrompt(text, targetRole), max_tokens: 2500 });
    audit = sanitizeAudit(extractJson(out?.response));
  } catch (e) {
    console.error(JSON.stringify({ event: "ats_mirror_audit_error", error: String(e?.message || e).slice(0, 200) }));
    return corsJson({ ok: false, error: "ai_error" }, 502);
  }
  if (!audit) return corsJson({ ok: false, error: "ai_parse_error" }, 502);

  // Pass 2: the rewritten resume (ATS-safe, facts preserved).
  let improved = "";
  try {
    const out = await env.AI.run(MODEL, {
      prompt: rewritePrompt(text, targetRole, audit.missing_keywords),
      max_tokens: 3500,
    });
    improved = String(out?.response || "").trim().slice(0, 12000);
  } catch (e) {
    console.error(JSON.stringify({ event: "ats_mirror_rewrite_error", error: String(e?.message || e).slice(0, 200) }));
    // Non-fatal: the audit is the core product; the rewrite is a bonus.
  }

  await recordAnonUse(env.JOBS_DB, ident.gateKey, "ats").catch(() => null);

  return corsJson({
    ok: true,
    audit,
    improved_resume: improved,
    target_role: targetRole || null,
    member: ident.member,
    remaining: Math.max(0, ident.remaining - 1),
  });
}

// Exported for unit tests (prompt honesty rules).
export { auditPrompt, rewritePrompt };
