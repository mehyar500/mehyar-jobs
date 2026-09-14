// /api/admin/sponsors — sponsor inventory CRUD (admin only).
//   GET  → list all sponsors (newest first)
//   POST → upsert: { id?, name, headline, body?, cta_text?, cta_url, slot, job_id?, starts_at?, ends_at?, is_active? }
//   DELETE ?id= → remove
//
// This is the paid-inventory control plane: newsletter slot ('email') and
// matches-page top slot ('matches'). Job seekers never pay; sponsors do.

import { requireAdmin, json, onRequestOptions } from "../../_shared/adminAuth.js";
import { ensureSchema } from "../../_shared/db.js";

export { onRequestOptions as onRequest };

const str = (v, max) => typeof v === "string" ? v.trim().slice(0, max) : null;

export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  await ensureSchema(env).catch(() => null);
  const rows = await env.JOBS_DB.prepare("SELECT * FROM sponsor ORDER BY id DESC LIMIT 200")
    .all().catch(() => ({ results: [] }));
  return json({ ok: true, sponsors: rows.results || [] }, 200, request, env);
}

export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  await ensureSchema(env).catch(() => null);
  const db = env.JOBS_DB;

  let body = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad_request" }, 400, request, env); }

  const name = str(body.name, 160);
  const headline = str(body.headline, 200);
  const cta_url = str(body.cta_url, 1000);
  if (!name || !headline || !cta_url) {
    return json({ ok: false, error: "missing_fields", required: ["name", "headline", "cta_url"] }, 400, request, env);
  }
  const slot = body.slot === "matches" ? "matches" : "email";
  const row = {
    id: body.id ? parseInt(body.id, 10) || null : null,
    name,
    headline,
    body: str(body.body, 2000),
    cta_text: str(body.cta_text, 80) || "Learn more",
    cta_url,
    slot,
    job_id: body.job_id ? parseInt(body.job_id, 10) || null : null,
    starts_at: str(body.starts_at, 32),
    ends_at: str(body.ends_at, 32),
    is_active: body.is_active === 0 || body.is_active === false ? 0 : 1,
  };

  if (row.id) {
    await db.prepare(`
      UPDATE sponsor SET name=?, headline=?, body=?, cta_text=?, cta_url=?, slot=?,
        job_id=?, starts_at=?, ends_at=?, is_active=? WHERE id=?
    `).bind(row.name, row.headline, row.body, row.cta_text, row.cta_url, row.slot,
      row.job_id, row.starts_at, row.ends_at, row.is_active, row.id).run();
    return json({ ok: true, id: row.id, updated: true }, 200, request, env);
  }
  const ins = await db.prepare(`
    INSERT INTO sponsor (name, headline, body, cta_text, cta_url, slot, job_id, starts_at, ends_at, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(row.name, row.headline, row.body, row.cta_text, row.cta_url, row.slot,
    row.job_id, row.starts_at, row.ends_at, row.is_active).run();
  return json({ ok: true, id: ins?.meta?.last_row_id }, 200, request, env);
}

export async function onRequestDelete({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  await ensureSchema(env).catch(() => null);
  const id = parseInt(new URL(request.url).searchParams.get("id") || "", 10);
  if (!Number.isFinite(id)) return json({ ok: false, error: "bad_id" }, 400, request, env);
  await env.JOBS_DB.prepare("DELETE FROM sponsor WHERE id = ?").bind(id).run().catch(() => null);
  return json({ ok: true, deleted: id }, 200, request, env);
}
