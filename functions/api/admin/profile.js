// GET   /api/admin/profile      → fetch user profile
// POST  /api/admin/profile      → save profile fields (JSON body)

import { requireAdmin, json, corsHeaders, onRequestOptions } from "../../_shared/adminAuth.js";
import { ensureSchema } from "../../_shared/db.js";

export { onRequestOptions as onRequest };

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
  };

  await env.JOBS_DB.prepare(`
    UPDATE profile
       SET target_titles_json = ?,
           keywords_json = ?,
           exclude_keywords_json = ?,
           locations_json = ?,
           remote_required = ?,
           min_salary_usd = ?,
           preferred_industries_json = ?,
           excluded_industries_json = ?,
           notes = ?,
           updated_at = datetime('now')
     WHERE id = 1
  `).bind(
    next.target_titles_json, next.keywords_json, next.exclude_keywords_json,
    next.locations_json, next.remote_required, next.min_salary_usd,
    next.preferred_industries_json, next.excluded_industries_json, next.notes,
  ).run().catch(async () => {
    // Row missing (e.g. before INSERT OR IGNORE ran); insert now.
    await env.JOBS_DB.prepare(`
      INSERT INTO profile
        (id, target_titles_json, keywords_json, exclude_keywords_json, locations_json,
         remote_required, min_salary_usd, preferred_industries_json, excluded_industries_json, notes)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      next.target_titles_json, next.keywords_json, next.exclude_keywords_json,
      next.locations_json, next.remote_required, next.min_salary_usd,
      next.preferred_industries_json, next.excluded_industries_json, next.notes,
    ).run();
  });

  const row = await env.JOBS_DB.prepare("SELECT * FROM profile WHERE id = 1").first();
  return json({ ok: true, profile: shapeOut(row) }, 200, request, env);
}

function safeArr(x) {
  if (Array.isArray(x)) return x.map((s) => String(s).trim()).filter(Boolean).slice(0, 200);
  if (typeof x === "string") return x.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 200);
  return [];
}
function numOrNull(x) {
  const n = Number(x);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
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
  };
}
function safeJson(s, fb) { try { return JSON.parse(s); } catch { return fb; } }