// /api/me/alerts — free job alerts for logged-in users.
//
// GET    → list the user's alerts
// POST   → create an alert { name?, q?, industry?, location?, remote?, employment_type? }
// DELETE → ?id=… removes one alert
//
// An alert replays the public job browser filters; the daily scanner emails
// the user only NEW jobs matching those filters since the last send.

import { ensureSchema } from "../../_shared/db.js";
import { json, onRequestOptions, requireUser } from "../../_shared/userAuth.js";

export { onRequestOptions as onRequest };

const MAX_ALERTS = 5;

function cleanFilters(body) {
  const f = {};
  const q = String(body.q || "").trim().slice(0, 120);
  if (q) f.q = q;
  const industry = String(body.industry || "").trim().slice(0, 80);
  if (industry) f.industry = industry;
  const location = String(body.location || "").trim().slice(0, 80);
  if (location) f.location = location;
  const remote = String(body.remote || "").trim().toLowerCase();
  if (["remote", "hybrid", "onsite"].includes(remote)) f.remote = remote;
  const et = String(body.employment_type || "").trim().toLowerCase();
  if (["employee", "contract"].includes(et)) f.employment_type = et;
  return f;
}

function autoName(filters) {
  const bits = [];
  if (filters.q) bits.push(`“${filters.q}”`);
  if (filters.industry) bits.push(filters.industry);
  if (filters.location) bits.push(filters.location);
  if (filters.remote) bits.push(filters.remote);
  if (filters.employment_type) bits.push(filters.employment_type);
  return bits.length ? `New: ${bits.join(" · ")}` : "New matching jobs";
}

function rowToAlert(r) {
  return {
    id: r.id,
    name: r.name,
    filters: JSON.parse(r.filters_json || "{}"),
    is_active: r.is_active === 1,
    last_sent_at: r.last_sent_at,
    last_match_count: r.last_match_count,
    created_at: r.created_at,
  };
}

export async function onRequestGet({ request, env }) {
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);
  const auth = await requireUser(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);

  const rows = await env.JOBS_DB.prepare(
    "SELECT * FROM job_alert WHERE user_id = ? ORDER BY created_at DESC"
  ).bind(auth.user.id).all().catch(() => ({ results: [] }));
  return json({ ok: true, alerts: (rows.results || []).map(rowToAlert) }, 200, request, env);
}

export async function onRequestPost({ request, env }) {
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);
  const auth = await requireUser(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);

  let body = {};
  try { body = await request.json(); } catch { /* fall through */ }
  const filters = cleanFilters(body);
  if (!Object.keys(filters).length) {
    return json({ ok: false, error: "empty_filters", message: "Set at least one filter (keyword, industry, location, or work style)." }, 400, request, env);
  }
  const name = String(body.name || "").trim().slice(0, 80) || autoName(filters);
  const filtersJson = JSON.stringify(filters);
  const db = env.JOBS_DB;

  const count = await db.prepare("SELECT COUNT(*) AS n FROM job_alert WHERE user_id = ? AND is_active = 1")
    .bind(auth.user.id).first().catch(() => ({ n: 0 }));
  if ((count?.n || 0) >= MAX_ALERTS) {
    return json({ ok: false, error: "too_many", message: `You can keep up to ${MAX_ALERTS} active alerts — delete one to add another.` }, 400, request, env);
  }

  const existing = await db.prepare("SELECT id FROM job_alert WHERE user_id = ? AND filters_json = ?")
    .bind(auth.user.id, filtersJson).first().catch(() => null);
  if (existing?.id) {
    return json({ ok: false, error: "duplicate", message: "You already have an alert with these exact filters." }, 409, request, env);
  }

  // Start the watermark at "now" so the first email only covers jobs that
  // appear AFTER the alert is created (no flood of old postings).
  const r = await db.prepare(`
    INSERT INTO job_alert (user_id, name, filters_json, last_sent_at, updated_at)
    VALUES (?, ?, ?, datetime('now'), datetime('now'))
  `).bind(auth.user.id, name, filtersJson).run().catch(() => null);
  const id = r?.meta?.last_row_id || null;
  return json({ ok: true, id, name, filters }, 200, request, env);
}

export async function onRequestDelete({ request, env }) {
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);
  const auth = await requireUser(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);

  const url = new URL(request.url);
  const id = parseInt(url.searchParams.get("id") || "0", 10);
  if (!id) return json({ ok: false, error: "id_required" }, 400, request, env);
  await env.JOBS_DB.prepare("DELETE FROM job_alert WHERE id = ? AND user_id = ?")
    .bind(id, auth.user.id).run().catch(() => null);
  return json({ ok: true, id }, 200, request, env);
}
