// GET  /api/me/resume — current resume metadata + text
// POST /api/me/resume — upload/replace resume { filename, mime, base64, text }
//   Stores the resume, re-derives the fit profile from its text, and
//   re-scores the user's matches on the next run.

import { ensureSchema } from "../../_shared/db.js";
import {
  json, onRequestOptions, requireUser, deriveProfileFromResume,
} from "../../_shared/userAuth.js";

export { onRequestOptions as onRequest };

const str = (v, max) => typeof v === "string" ? v.slice(0, max) : null;

export async function onRequestGet({ request, env }) {
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);
  const auth = await requireUser(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);

  const resume = await env.JOBS_DB.prepare(
    "SELECT id, filename, mime, text, created_at FROM user_resume WHERE user_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 1"
  ).bind(auth.user.id).first().catch(() => null);
  const profile = await env.JOBS_DB.prepare(
    "SELECT target_titles_json, keywords_json, locations_json FROM user_profile WHERE user_id = ?"
  ).bind(auth.user.id).first().catch(() => null);

  return json({
    ok: true,
    resume: resume ? {
      filename: resume.filename, mime: resume.mime,
      text: resume.text, created_at: resume.created_at,
      text_length: (resume.text || "").length,
    } : null,
    derived: profile ? {
      target_titles: JSON.parse(profile.target_titles_json || "[]"),
      keywords: JSON.parse(profile.keywords_json || "[]"),
      locations: JSON.parse(profile.locations_json || "[]"),
    } : null,
  }, 200, request, env);
}

export async function onRequestPost({ request, env }) {
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);
  const auth = await requireUser(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);

  let body = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad_request" }, 400, request, env); }

  const base64 = str(body.resume_base64, 4_000_000);
  if (base64 && base64.length > 4_000_000) {
    return json({ ok: false, error: "resume_too_large" }, 400, request, env);
  }
  const text = str(body.resume_text, 60_000);
  if (!text || text.trim().length < 50) {
    return json({ ok: false, error: "resume_text_required", message: "Paste your resume as plain text (or upload a file we can read)." }, 400, request, env);
  }

  const db = env.JOBS_DB;
  await db.prepare("UPDATE user_resume SET is_active = 0 WHERE user_id = ?").bind(auth.user.id).run().catch(() => null);
  await db.prepare(`
    INSERT INTO user_resume (user_id, filename, mime, base64, text, is_active)
    VALUES (?, ?, ?, ?, ?, 1)
  `).bind(
    auth.user.id,
    str(body.resume_filename, 200) || "resume.txt",
    str(body.resume_mime, 100) || "text/plain",
    base64,
    text
  ).run().catch(() => null);

  // Re-derive the fit profile from the new resume, preserving any titles
  // the user hand-entered at signup.
  const existing = await db.prepare(
    "SELECT target_titles_json, locations_json FROM user_profile WHERE user_id = ?"
  ).bind(auth.user.id).first().catch(() => null);
  let keepTitles = [];
  let keepLocations = [];
  try {
    keepTitles = JSON.parse(existing?.target_titles_json || "[]");
    keepLocations = JSON.parse(existing?.locations_json || "[]");
  } catch {}
  const derived = deriveProfileFromResume(text, { target_titles: keepTitles, locations: keepLocations });
  await db.prepare(`
    INSERT INTO user_profile (user_id, target_titles_json, keywords_json, locations_json, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      target_titles_json = excluded.target_titles_json,
      keywords_json = excluded.keywords_json,
      locations_json = CASE WHEN user_profile.locations_json = '[]' THEN excluded.locations_json ELSE user_profile.locations_json END,
      updated_at = datetime('now')
  `).bind(auth.user.id, JSON.stringify(derived.target_titles), JSON.stringify(derived.keywords), JSON.stringify(derived.locations)).run().catch(() => null);

  // Old scores were for the previous resume — clear them so the next run is fresh.
  await db.prepare("DELETE FROM user_job_fit WHERE user_id = ?").bind(auth.user.id).run().catch(() => null);

  return json({
    ok: true,
    derived: {
      target_titles: derived.target_titles,
      keywords: derived.keywords.slice(0, 12),
      keyword_count: derived.keywords.length,
    },
  }, 200, request, env);
}
