// POST /api/admin/jobs/{id}/feature — toggle the employer featured flag.
//   body: { featured: 0|1, featured_until?: "YYYY-MM-DD", note? }
//
// Featured listings render with a "Featured" badge + "Sponsored" label.
// Payment is collected manually (see /advertise + request-featured);
// this endpoint is the admin approval switch.

import { requireAdmin, json, onRequestOptions } from "../../../../_shared/adminAuth.js";
import { ensureSchema } from "../../../../_shared/db.js";

export { onRequestOptions as onRequest };

export async function onRequestPost({ request, env, params }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  await ensureSchema(env).catch(() => null);
  const db = env.JOBS_DB;

  const jobId = parseInt(params?.id, 10);
  if (!Number.isFinite(jobId)) return json({ ok: false, error: "bad_job_id" }, 400, request, env);

  let body = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad_request" }, 400, request, env); }

  const featured = body.featured === 1 || body.featured === true ? 1 : 0;
  const until = typeof body.featured_until === "string" && body.featured_until.trim()
    ? body.featured_until.trim().slice(0, 32) : null;
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : null;

  const job = await db.prepare("SELECT id FROM job WHERE id = ?").bind(jobId).first().catch(() => null);
  if (!job) return json({ ok: false, error: "job_not_found" }, 404, request, env);

  await db.prepare("UPDATE job SET featured = ?, featured_until = ?, featured_note = ? WHERE id = ?")
    .bind(featured, until, note, jobId).run();

  return json({ ok: true, job_id: jobId, featured, featured_until: until }, 200, request, env);
}
