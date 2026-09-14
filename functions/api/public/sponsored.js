// GET /api/public/sponsored?slot=matches
//
// Returns the currently active sponsor for a slot (public, no auth).
// Used by the matches page "top match" slot. Paid inventory is always
// labeled "Sponsored" at render time.

import { json, onRequestOptions } from "../../_shared/adminAuth.js";
import { ensureSchema } from "../../_shared/db.js";
import { getActiveSponsor } from "../../_shared/sponsors.js";

export { onRequestOptions as onRequest };

export async function onRequestGet({ request, env }) {
  await ensureSchema(env).catch(() => null);
  const db = env?.JOBS_DB;
  if (!db) return json({ ok: false, error: "no_db" }, 500, request, env);

  const url = new URL(request.url);
  const slot = url.searchParams.get("slot") || "matches";
  if (!["email", "matches"].includes(slot)) {
    return json({ ok: false, error: "bad_slot" }, 400, request, env);
  }

  const sponsor = await getActiveSponsor(db, slot).catch(() => null);
  if (!sponsor) return json({ ok: true, sponsor: null }, 200, request, env);

  let job = null;
  if (sponsor.job_id) {
    job = await db.prepare(`
      SELECT j.id, j.title, j.url, j.location, j.remote_policy,
             j.salary_min, j.salary_max, j.salary_currency,
             c.name AS company_name
      FROM job j JOIN company c ON c.id = j.company_id
      WHERE j.id = ? AND j.is_active = 1
    `).bind(sponsor.job_id).first().catch(() => null);
  }
  return json({ ok: true, sponsor: { ...sponsor, job } }, 200, request, env);
}
