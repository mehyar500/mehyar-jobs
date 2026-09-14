// Admin: offer-slot affiliate config.
//
// GET  /api/admin/offer-slots          — list slots (config keys Mayor must fill)
// PUT  /api/admin/offer-slots          — { key, cta_url?, headline?, body?, cta_text?, image_url?, sms_copy?, is_active? }
// Slots with empty cta_url render "coming soon" on the offer page.

import { json, onRequestOptions, requireAdmin } from "../../_shared/adminAuth.js";
import { ensureSchema } from "../../_shared/db.js";

export { onRequestOptions as onRequest };

const FIELDS = ["headline", "body", "cta_text", "cta_url", "image_url", "sms_copy", "is_active", "priority", "name"];

export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message || "unauthorized" }, auth.status || 401, request, env);
  await ensureSchema(env).catch(() => null);
  const db = env?.JOBS_DB;
  const r = await db.prepare("SELECT key, name, slot_type, headline, body, cta_text, cta_url, image_url, sms_copy, priority, is_active FROM offer_slot ORDER BY priority")
    .all().catch(() => ({ results: [] }));
  const slots = r.results || [];
  return json({
    ok: true,
    slots,
    // The exact config keys Mayor must fill with his approved affiliate links:
    missing_links: slots.filter((s) => !s.cta_url && s.is_active).map((s) => s.key),
  }, 200, request, env);
}

export async function onRequestPut({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message || "unauthorized" }, auth.status || 401, request, env);
  await ensureSchema(env).catch(() => null);
  const db = env?.JOBS_DB;
  let b = {};
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400, request, env); }
  const key = String(b.key || "");
  if (!key) return json({ ok: false, error: "key_required" }, 400, request, env);

  const sets = [], vals = [];
  for (const f of FIELDS) {
    if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(f === "is_active" ? (b[f] ? 1 : 0) : b[f]); }
  }
  if (!sets.length) return json({ ok: false, error: "nothing_to_update" }, 400, request, env);
  const r = await db.prepare(`UPDATE offer_slot SET ${sets.join(", ")} WHERE key = ?`)
    .bind(...vals, key).run().catch(() => null);
  if (!r || (r.meta?.changes ?? 0) === 0) return json({ ok: false, error: "unknown_key" }, 404, request, env);
  return json({ ok: true, key }, 200, request, env);
}
