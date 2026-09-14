// Admin: daily campaign report ("Mayor Jobs" tab data).
//
// GET /api/admin/email/campaign-report?date=YYYY-MM-DD
//   date defaults to today (UTC); bad format -> 400.
//   Server-side SMTP2GO stats (email_history for the day) are fetched here
//   — never in the browser — with a try/catch so a provider failure still
//   returns the D1-backed report with provider.error attached.

import { json, onRequestOptions, requireAdmin } from "../../../_shared/adminAuth.js";
import { ensureSchema } from "../../../_shared/db.js";
import { buildCampaignReport } from "../../../_shared/campaignReport.js";

export { onRequestOptions as onRequest };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Fetch one day of SMTP2GO email_history. Returns { ok, stats? } or
 * { ok: false, error } — the report still ships on provider failure.
 * @param {string} apiKey
 * @param {string} dateStr
 */
async function smtp2goDayStats(apiKey, dateStr) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch("https://api.smtp2go.com/v3/stats/email_history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        api_key: apiKey,
        start_date: `${dateStr} 00:00:00`,
        end_date: `${dateStr} 23:59:59`,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: `smtp2go http ${r.status}` };
    return { ok: true, stats: j?.data ?? j };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message || "unauthorized" }, auth.status || 401, request, env);
  await ensureSchema(env).catch(() => null);

  const url = new URL(request.url);
  let dateStr = url.searchParams.get("date");
  if (!dateStr) dateStr = new Date().toISOString().slice(0, 10);
  if (!DATE_RE.test(dateStr)) {
    return json({ ok: false, error: "bad_date: use YYYY-MM-DD" }, 400, request, env);
  }

  let provider = null;
  const apiKey = env.SMTP2GO_API_KEY || "";
  if (apiKey) {
    const res = await smtp2goDayStats(apiKey, dateStr);
    provider = res.ok ? { source: "smtp2go", ...res.stats } : { source: "smtp2go", error: res.error };
  } else {
    provider = { source: "smtp2go", error: "SMTP2GO_API_KEY not configured" };
  }

  const report = await buildCampaignReport(env.JOBS_DB, dateStr, { smtp2goStats: provider });
  return json({ ok: true, date: dateStr, provider: report.provider, ...report }, 200, request, env);
}
