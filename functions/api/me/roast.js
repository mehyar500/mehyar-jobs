// /api/me/roast — shareable resume roast (PII-stripped by construction).
//   POST   → mint a public roast link from the user's latest AI review
//   DELETE ?id=<public_id> → remove a roast you own
//
// Only score/verdict/strengths/gaps are published — never resume text,
// name, email, or phone.

import { json, onRequestOptions } from "../../_shared/adminAuth.js";
import { ensureSchema } from "../../_shared/db.js";
import { requireUser } from "../../_shared/userAuth.js";

export { onRequestOptions as onRequest };

function publicId() {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => chars[b % chars.length]).join("");
}

const cleanList = (v) => Array.isArray(v)
  ? v.map((x) => String(x).slice(0, 300)).filter(Boolean).slice(0, 8) : [];

export async function onRequestPost({ request, env }) {
  const auth = await requireUser(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  await ensureSchema(env).catch(() => null);
  const db = env.JOBS_DB;

  const resume = await db.prepare(
    "SELECT llm_review_json FROM user_resume WHERE user_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 1"
  ).bind(auth.user.id).first().catch(() => null);
  let review = null;
  try { review = resume?.llm_review_json ? JSON.parse(resume.llm_review_json) : null; } catch { review = null; }
  if (!review || typeof review.score !== "number") {
    return json({ ok: false, error: "no_review", message: "Run the AI resume review first, then share your roast." }, 400, request, env);
  }

  const pid = publicId();
  await db.prepare(`
    INSERT INTO roast (public_id, user_id, score, verdict, strengths_json, gaps_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    pid, auth.user.id,
    Math.max(0, Math.min(100, Math.round(review.score))),
    String(review.verdict || "").slice(0, 400),
    JSON.stringify(cleanList(review.strengths)),
    JSON.stringify(cleanList(review.gaps))
  ).run();

  const appUrl = env.JOBS_APP_URL || "https://jobs.mehyar.us";
  return json({ ok: true, public_id: pid, url: `${appUrl}/roast/${pid}` }, 200, request, env);
}

export async function onRequestDelete({ request, env }) {
  const auth = await requireUser(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  await ensureSchema(env).catch(() => null);
  const pid = String(new URL(request.url).searchParams.get("id") || "");
  await env.JOBS_DB.prepare("DELETE FROM roast WHERE public_id = ? AND user_id = ?")
    .bind(pid, auth.user.id).run().catch(() => null);
  return json({ ok: true }, 200, request, env);
}
