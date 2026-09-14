// POST /api/public/recruiter-lead — "get matched with recruiters" opt-in.
//
// Captures explicit consent (checkbox required) + profile. Stored as a
// sellable lead; NO buyer is wired — leads accumulate in recruiter_lead
// with status 'new' until Mayor approves a buyer.

import { json, onRequestOptions } from "../../_shared/adminAuth.js";
import { ensureSchema } from "../../_shared/db.js";

export { onRequestOptions as onRequest };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const RECRUITER_CONSENT_TEXT =
  "I agree that mehyar.jobs may share my profile (name, title, skills, location) with vetted recruiters and employers for job matching. I can withdraw anytime via the unsubscribe page.";

export async function onRequestPost({ request, env }) {
  await ensureSchema(env).catch(() => null);
  const db = env?.JOBS_DB;
  if (!db) return json({ ok: false, error: "no_db" }, 500, request, env);
  let b = {};
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400, request, env); }

  // Explicit consent is mandatory — no checkbox, no lead.
  if (b.consent !== true) {
    return json({ ok: false, error: "consent_required" }, 400, request, env);
  }
  const email = String(b.email || "").trim().toLowerCase();
  if (email && !EMAIL_RE.test(email)) return json({ ok: false, error: "bad_email" }, 400, request, env);

  const skills = Array.isArray(b.skills) ? b.skills.map(String).slice(0, 30) : [];
  const contactId = Number(b.contact_id) || null;
  const res = await db.prepare(`
    INSERT INTO recruiter_lead (contact_id, name, email, phone, title, skills_json, location, remote_ok, consent_text, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')
  `).bind(
    contactId,
    String(b.name || "").slice(0, 120) || null,
    email || null,
    String(b.phone || "").slice(0, 32) || null,
    String(b.title || "").slice(0, 160) || null,
    JSON.stringify(skills),
    String(b.location || "").slice(0, 120) || null,
    b.remote_ok ? 1 : 0,
    RECRUITER_CONSENT_TEXT
  ).run().catch(() => null);
  if (!res) return json({ ok: false, error: "db_error" }, 500, request, env);
  return json({ ok: true, lead_id: res.meta.last_row_id }, 200, request, env);
}
