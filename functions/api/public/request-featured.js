// POST /api/public/request-featured — employer asks to feature a listing.
//
// Manual flow (no payments wired yet): the request lands in featured_request
// and the admin gets an email. Admin approves via
// POST /api/admin/jobs/{id}/feature.

import { json, onRequestOptions } from "../../_shared/adminAuth.js";
import { ensureSchema } from "../../_shared/db.js";
import { sendEmail } from "../../_shared/email.js";

export { onRequestOptions as onRequest };

const str = (v, max) => typeof v === "string" ? v.trim().slice(0, max) : "";

export async function onRequestPost({ request, env }) {
  await ensureSchema(env).catch(() => null);
  const db = env?.JOBS_DB;
  if (!db) return json({ ok: false, error: "no_db" }, 500, request, env);

  let body = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad_request" }, 400, request, env); }

  const company_name = str(body.company_name, 160);
  const contact_email = str(body.contact_email, 320).toLowerCase();
  const job_url = str(body.job_url, 1000);
  const job_title = str(body.job_title, 200);
  const message = str(body.message, 2000);

  if (!company_name || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(contact_email)) {
    return json({ ok: false, error: "invalid_fields", message: "Company name and a valid email are required." }, 400, request, env);
  }

  const ins = await db.prepare(`
    INSERT INTO featured_request (company_name, contact_email, job_url, job_title, message)
    VALUES (?, ?, ?, ?, ?)
  `).bind(company_name, contact_email, job_url || null, job_title || null, message || null).run().catch(() => null);
  const reqId = ins?.meta?.last_row_id || null;

  // Notify the admin (best-effort; the request is already stored).
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  await sendEmail(env, {
    subject: `⭐ Featured-post request #${reqId ?? "?"}: ${company_name}`,
    text: [
      `New featured-listing request (pricing: $49–99, manual collection):`,
      ``,
      `Company: ${company_name}`,
      `Contact: ${contact_email}`,
      `Job: ${job_title || "—"}`,
      `URL: ${job_url || "—"}`,
      `Message: ${message || "—"}`,
      ``,
      `Approve: POST /api/admin/jobs/{id}/feature with { featured: 1 }`,
    ].join("\n"),
    html: `<p>New <strong>featured-listing request</strong> ($49–99, manual collection):</p>
      <ul><li>Company: <strong>${esc(company_name)}</strong></li>
      <li>Contact: ${esc(contact_email)}</li>
      <li>Job: ${esc(job_title || "—")}</li>
      <li>URL: <a href="${esc(job_url)}">${esc(job_url || "—")}</a></li>
      <li>Message: ${esc(message || "—")}</li></ul>
      <p>Approve via <code>POST /api/admin/jobs/{id}/feature</code> with <code>{ featured: 1 }</code>.</p>`,
  }).catch(() => null);

  return json({ ok: true, request_id: reqId, message: "Request received — we'll reply within one business day." }, 200, request, env);
}
