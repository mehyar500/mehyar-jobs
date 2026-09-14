// scanner-worker/src/review.js
//
// POST /review — LLM resume review & scoring (Workers AI).
// Mirrors the deterministic fit engine's philosophy: a 0-100 hireability
// score plus structured reasons (strengths, gaps, keywords, titles).
// Auth: same Bearer user token the Pages API issues (requireUser).
// CORS is open for the Pages frontend; the token is the auth.

import { requireUser } from "../../functions/_shared/userAuth.js";
import { ensureSchema } from "../../functions/_shared/db.js";

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";
const MAX_RESUME_CHARS = 12000;

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

function parseReview(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[0]); } catch { return null; }
  if (typeof j.score !== "number" || Number.isNaN(j.score)) return null;
  j.score = Math.max(0, Math.min(100, Math.round(j.score)));
  for (const k of ["strengths", "gaps", "missing_keywords", "suggested_titles", "improvements"]) {
    j[k] = Array.isArray(j[k]) ? j[k].map((x) => String(x).slice(0, 300)).slice(0, 8) : [];
  }
  j.verdict = typeof j.verdict === "string" ? j.verdict.slice(0, 400) : "";
  return j;
}

function reviewPrompt(resumeText) {
  return [
    "You are a senior hiring manager and resume coach. Review the resume below and score it the way a job-fit engine would: how hireable and keyword-strong it is across the open job market right now.",
    "",
    "Return ONLY valid JSON — no markdown, no commentary, no code fences — with exactly these keys:",
    "{",
    '  "score": <integer 0-100>,',
    '  "verdict": "<one-sentence overall verdict>",',
    '  "strengths": ["...", "...", "..."],',
    '  "gaps": ["...", "...", "..."],',
    '  "missing_keywords": ["...", "..."],',
    '  "suggested_titles": ["...", "...", "..."],',
    '  "improvements": ["...", "...", "..."]',
    "}",
    "Score honestly like a fit engine, not a cheerleader: most resumes land 40-70. Reserve 80+ for resumes with quantified achievements, in-demand keywords, and clear seniority signals. Keep each list item to one line.",
    "",
    "Resume:",
    resumeText,
  ].join("\n");
}

export async function handleReview(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return corsJson({ ok: false, error: "method_not_allowed" }, 405);

  await ensureSchema(env);

  if (!env.AI || typeof env.AI.run !== "function") {
    return corsJson({ ok: false, error: "ai_unavailable" }, 503);
  }

  const auth = await requireUser(request, env);
  if (!auth.ok) return corsJson({ ok: false, error: auth.message }, auth.status);

  let body = {};
  try { body = await request.json(); } catch { /* fall through */ }

  let text = String(body.resume_text || "").slice(0, MAX_RESUME_CHARS);
  let resumeId = null;
  if (!text.trim()) {
    const row = await env.JOBS_DB.prepare(
      "SELECT id, text FROM user_resume WHERE user_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 1"
    ).bind(auth.user.id).first().catch(() => null);
    if (!row?.text || !String(row.text).trim()) {
      return corsJson({ ok: false, error: "no_resume" }, 400);
    }
    text = String(row.text).slice(0, MAX_RESUME_CHARS);
    resumeId = row.id;
  }
  if (text.trim().length < 200) return corsJson({ ok: false, error: "resume_too_short" }, 400);

  let review = null;
  try {
    const out = await env.AI.run(MODEL, { prompt: reviewPrompt(text), max_tokens: 1500 });
    review = parseReview(out?.response);
  } catch (e) {
    console.error(JSON.stringify({ event: "review_ai_error", error: String(e?.message || e).slice(0, 200) }));
    return corsJson({ ok: false, error: "ai_error", detail: String(e?.message || e).slice(0, 200) }, 502);
  }
  if (!review) return corsJson({ ok: false, error: "ai_parse_error" }, 502);

  // Persist on the active resume row when we reviewed the saved one, so the
  // /review page can show the last result without re-running inference.
  if (resumeId) {
    await env.JOBS_DB.prepare("UPDATE user_resume SET llm_review_json = ? WHERE id = ? AND user_id = ?")
      .bind(JSON.stringify(review), resumeId, auth.user.id).run().catch(() => null);
  }

  return corsJson({ ok: true, review }, 200);
}
