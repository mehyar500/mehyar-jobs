// GET   /api/admin/profile      → fetch user profile
// POST  /api/admin/profile      → save profile fields (JSON body)
//
// Extended for browser-based auto-submit: stores resume file (base64),
// LinkedIn / GitHub / portfolio URLs, default form answers, work
// auth / sponsorship / EEO fields. All fields are editable from the
// Profile tab in the UI.

import { requireAdmin, json, corsHeaders, onRequestOptions } from "../../_shared/adminAuth.js";
import { ensureSchema } from "../../_shared/db.js";

export { onRequestOptions as onRequest };

const COLS = [
  "target_titles", "keywords", "exclude_keywords", "locations",
  "remote_required", "min_salary_usd",
  "preferred_industries", "excluded_industries", "notes",
  // new fields for browser auto-fill
  "resume_filename", "resume_mime", "resume_base64", "resume_text",
  "linkedin_url", "github_url", "portfolio_url", "personal_website",
  "phone", "city", "country",
  "work_auth", "years_experience", "current_title", "current_company",
  "current_salary", "notice_period",
  "gender", "ethnicity", "veteran_status", "disability", "hispanic_latino",
  "cleartext_address", "default_answers",
];

export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);

  await ensureSchema(env);
  const row = await env.JOBS_DB.prepare("SELECT * FROM profile WHERE id = 1").first();
  return json({ ok: true, profile: shapeOut(row) }, 200, request, env);
}

export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);

  await ensureSchema(env);
  const body = await request.json().catch(() => ({}));

  // Resume file size cap (base64 of ~2MB PDF ≈ 2.7MB string). Hard cap at 3MB.
  if (body.resume_base64 && typeof body.resume_base64 === "string" && body.resume_base64.length > 4_000_000) {
    return json({ ok: false, error: "resume_too_large", max_bytes: 3_000_000 }, 400, request, env);
  }

  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const next = {
    target_titles_json:        JSON.stringify(safeArr(body.target_titles)),
    keywords_json:             JSON.stringify(safeArr(body.keywords)),
    exclude_keywords_json:     JSON.stringify(safeArr(body.exclude_keywords)),
    locations_json:            JSON.stringify(safeArr(body.locations)),
    remote_required:           body.remote_required ? 1 : 0,
    min_salary_usd:            numOrNull(body.min_salary_usd),
    preferred_industries_json: JSON.stringify(safeArr(body.preferred_industries)),
    excluded_industries_json:  JSON.stringify(safeArr(body.excluded_industries)),
    notes:                     typeof body.notes === "string" ? body.notes.slice(0, 8000) : null,
    // new
    resume_filename:           strOrNull(body.resume_filename, 200),
    resume_mime:               strOrNull(body.resume_mime, 100),
    resume_base64:              strOrNull(body.resume_base64, 4_000_000),
    resume_text:                strOrNull(body.resume_text, 50_000),
    linkedin_url:               strOrNull(body.linkedin_url, 500),
    github_url:                 strOrNull(body.github_url, 500),
    portfolio_url:              strOrNull(body.portfolio_url, 500),
    personal_website:           strOrNull(body.personal_website, 500),
    phone:                      strOrNull(body.phone, 50),
    city:                       strOrNull(body.city, 200),
    country:                    strOrNull(body.country, 100),
    work_auth:                  strOrNull(body.work_auth, 200),
    years_experience:           numOrNullInt(body.years_experience),
    current_title:              strOrNull(body.current_title, 200),
    current_company:            strOrNull(body.current_company, 200),
    current_salary:             numOrNullInt(body.current_salary),
    notice_period:              strOrNull(body.notice_period, 100),
    gender:                     strOrNull(body.gender, 100),
    ethnicity:                  strOrNull(body.ethnicity, 200),
    veteran_status:             strOrNull(body.veteran_status, 200),
    disability:                 strOrNull(body.disability, 200),
    hispanic_latino:            strOrNull(body.hispanic_latino, 200),
    cleartext_address:          strOrNull(body.cleartext_address, 500),
    default_answers_json:       JSON.stringify(safeObj(body.default_answers)),
    updated_at:                 now,
  };

  const setSql = Object.keys(next).map((k) => k + " = ?").join(", ");
  const vals   = Object.values(next);

  try {
    await env.JOBS_DB.prepare(`UPDATE profile SET ${setSql} WHERE id = 1`).bind(...vals).run();
  } catch (e) {
    // Row missing — fall back to insert
    const cols = Object.keys(next).join(", ");
    const qs   = Object.keys(next).map(() => "?").join(", ");
    await env.JOBS_DB.prepare(`INSERT INTO profile (id, ${cols}) VALUES (1, ${qs})`).bind(...vals).run();
  }

  const row = await env.JOBS_DB.prepare("SELECT * FROM profile WHERE id = 1").first();
  return json({ ok: true, profile: shapeOut(row) }, 200, request, env);
}

function safeArr(x) {
  if (Array.isArray(x)) return x.map((s) => String(s).trim()).filter(Boolean).slice(0, 200);
  if (typeof x === "string") return x.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 200);
  return [];
}
function safeObj(x) {
  if (!x || typeof x !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(x)) {
    if (typeof v === "string") out[String(k).slice(0, 200)] = v.slice(0, 4000);
    else if (typeof v === "number" || typeof v === "boolean") out[String(k).slice(0, 200)] = v;
  }
  return out;
}
function numOrNull(x) {
  const n = Number(x);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}
function numOrNullInt(x) {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}
function strOrNull(x, max) {
  if (x == null) return null;
  if (typeof x !== "string") return null;
  return x.slice(0, max);
}
function shapeOut(row) {
  if (!row) return null;
  return {
    target_titles:        safeJson(row.target_titles_json, []),
    keywords:             safeJson(row.keywords_json, []),
    exclude_keywords:     safeJson(row.exclude_keywords_json, []),
    locations:            safeJson(row.locations_json, []),
    remote_required:      !!row.remote_required,
    min_salary_usd:       row.min_salary_usd || null,
    preferred_industries: safeJson(row.preferred_industries_json, []),
    excluded_industries:  safeJson(row.excluded_industries_json, []),
    notes:                row.notes || "",
    updated_at:           row.updated_at,
    // new
    resume_filename:      row.resume_filename || "",
    resume_mime:          row.resume_mime || "",
    resume_text:          row.resume_text || "",
    has_resume:           !!row.resume_base64,
    linkedin_url:         row.linkedin_url || "",
    github_url:           row.github_url || "",
    portfolio_url:        row.portfolio_url || "",
    personal_website:     row.personal_website || "",
    phone:                row.phone || "",
    city:                 row.city || "",
    country:              row.country || "",
    work_auth:            row.work_auth || "",
    years_experience:     row.years_experience || null,
    current_title:        row.current_title || "",
    current_company:      row.current_company || "",
    current_salary:       row.current_salary || null,
    notice_period:        row.notice_period || "",
    gender:               row.gender || "",
    ethnicity:            row.ethnicity || "",
    veteran_status:       row.veteran_status || "",
    disability:           row.disability || "",
    hispanic_latino:      row.hispanic_latino || "",
    cleartext_address:    row.cleartext_address || "",
    default_answers:      safeJson(row.default_answers_json, {}),
  };
}
function safeJson(s, fb) { try { return JSON.parse(s); } catch { return fb; } }
