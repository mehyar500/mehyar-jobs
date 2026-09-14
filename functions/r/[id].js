// GET /r/<public_id> — signed tap-tracked redirect.
//
// Logs the tap (marks the subscriber as a tapper for engagement-based
// sending), then 302s to the link target. Unknown ids 404.

import { ensureSchema } from "../_shared/db.js";
import { recordTap } from "../_shared/sms.js";
import { pageChrome, APP_URL } from "../_shared/seo.js";

export async function onRequestGet({ env, params, request }) {
  const id = String(params?.id || "").slice(0, 64);
  await ensureSchema(env).catch(() => null);
  const db = env?.JOBS_DB;

  const link = id && db
    ? await recordTap(db, id, {
        ip: request.headers.get("cf-connecting-ip"),
        ua: request.headers.get("user-agent"),
      })
    : null;

  if (!link?.target_url) {
    const html = pageChrome({
      title: "Link not found — mehyar.jobs", noindex: true,
      body: `<h1>Link not found</h1><p class="muted"><a href="${APP_URL}/">Back to mehyar.jobs →</a></p>`,
    });
    return new Response(html, { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  return Response.redirect(link.target_url, 302);
}
