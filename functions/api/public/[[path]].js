// GET /api/public/profile  → no auth, returns the user's profile (used by fit logic on shared endpoints)
// GET /api/public/stats    → no auth, returns public stats (companies, jobs, scraped-at)
// GET /api/health          → no auth, health probe
// POST /api/public/free-run → no auth, one free resume check per visitor (IP-hashed)

import { json, corsHeaders, onRequestOptions } from "../../_shared/adminAuth.js";
import { ensureSchema } from "../../_shared/db.js";
import { scoreJob } from "../../_shared/fit.js";
import { deriveProfileFromResume, verifyAlertToken } from "../../_shared/userAuth.js";
import { clientIpHash, anonUsage, recordAnonUse } from "../../_shared/anonGate.js";

export { onRequestOptions as onRequest };

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/api\/public\/?/, "");

  if (path === "health" || url.pathname.endsWith("/api/public/health")) {
    const ok = !!env?.JOBS_DB;
    return json({ ok, db: !!env?.JOBS_DB, ts: new Date().toISOString() }, 200, request, env);
  }

  if (path === "stats" || url.pathname.endsWith("/api/public/stats")) {
    const db = env?.JOBS_DB;
    if (!db) return json({ ok: false, error: "no_db" }, 500, request, env);
    const counts = await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM company) AS companies,
        (SELECT COUNT(*) FROM job WHERE is_active = 1) AS active_jobs,
        (SELECT COUNT(*) FROM job WHERE is_active = 1 AND date(first_seen_at) = date('now')) AS jobs_today,
        (SELECT MAX(scrape_last_at) FROM company) AS last_scrape_at,
        (SELECT COUNT(*) FROM scrape_run) AS scrape_runs
    `).first().catch(() => ({ companies: 0, active_jobs: 0, jobs_today: 0, last_scrape_at: null, scrape_runs: 0 }));
    const industries = await db.prepare(`
      SELECT c.industry AS name, COUNT(*) AS jobs
      FROM company c JOIN job j ON j.company_id = c.id
      WHERE j.is_active = 1 AND c.industry IS NOT NULL AND c.industry != ''
      GROUP BY c.industry ORDER BY jobs DESC LIMIT 24
    `).all().then((r) => r.results || []).catch(() => []);
    return json({ ok: true, ...counts, industries, ts: new Date().toISOString() }, 200, request, env);
  }

  if (path === "alert-off" || url.pathname.endsWith("/api/public/alert-off")) {
    return handleAlertOff(request, env);
  }

  return json({ ok: false, error: "not_found", path }, 404, request, env);
}

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/api\/public\/?/, "");
  if (path === "free-run" || url.pathname.endsWith("/api/public/free-run")) {
    return handleFreeRun(request, env);
  }
  if (path === "parse-resume" || url.pathname.endsWith("/api/public/parse-resume")) {
    return handleParseResume(request, env);
  }
  return json({ ok: false, error: "not_found", path }, 404, request, env);
}

// POST /api/public/parse-resume — multipart file → clean text.
// Powers the Studio file picker and member profile uploads. Never consumes
// the visitor's one free check; lightly rate-limited per IP hash instead.
async function handleParseResume(request, env) {
  await ensureSchema(env).catch(() => null);
  const db = env?.JOBS_DB;

  // Abuse guard: 30 parses/day per visitor (members bypass via session).
  let member = false;
  try {
    const { requireUser } = await import("../../_shared/userAuth.js");
    const auth = await requireUser(request, env);
    if (auth?.ok) member = true;
  } catch { /* anonymous */ }
  let ipHash = null;
  if (!member && db) {
    ipHash = await clientIpHash(request, env);
    const usage = await anonUsage(db, ipHash, "parse").catch(() => ({ usedToday: 0 }));
    if (usage.usedToday >= 30) {
      return json({ ok: false, error: "rate_limited", message: "Too many uploads today — try again tomorrow." }, 429, request, env);
    }
  }

  let file = null;
  try {
    const form = await request.formData();
    file = form.get("file");
  } catch {
    return json({ ok: false, error: "bad_request", message: "Send the file as multipart form-data (field: file)." }, 400, request, env);
  }
  if (!file || typeof file.arrayBuffer !== "function") {
    return json({ ok: false, error: "no_file", message: "No file attached." }, 400, request, env);
  }
  if (file.size > 3_000_000) {
    return json({ ok: false, error: "too_large", message: "Resume must be under 3MB." }, 400, request, env);
  }
  if (file.size < 10) {
    return json({ ok: false, error: "empty_file", message: "That file is empty." }, 400, request, env);
  }

  try {
    const { extractResumeText } = await import("../../_shared/extractText.js");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const out = await extractResumeText(bytes, file.name || "resume", file.type || "");
    if (db && ipHash) await recordAnonUse(db, ipHash, "parse").catch(() => null);
    return json({
      ok: true,
      filename: file.name || "resume",
      format: out.format,
      pages: out.pages || null,
      text: out.text,
      char_count: out.text.length,
      warnings: out.warnings || [],
    }, 200, request, env);
  } catch (e) {
    const code = e?.code || "parse_failed";
    const message = e?.message || "Couldn't read that file — try a .pdf, .docx, or .txt export.";
    const status = ["too_large", "empty_file", "legacy_doc", "binary_file", "empty_pdf", "empty_docx", "bad_docx"].includes(code) ? 422 : 500;
    return json({ ok: false, error: code, message }, status, request, env);
  }
}

// GET /api/public/alert-off?token=… — one-click "turn off this alert"
// from alert emails. No login needed; the token binds alert id + owner.
async function handleAlertOff(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || "";
  const v = await verifyAlertToken(token, env).catch(() => null);
  const html = (title, body) => new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>` +
    `<body style="font-family:-apple-system,sans-serif;max-width:560px;margin:48px auto;padding:0 20px;text-align:center;color:#18181b">` +
    `<div style="font-size:48px;margin-bottom:16px">${v ? "🔕" : "⚠️"}</div><h1 style="font-size:22px">${title}</h1>` +
    `<p style="color:#71717a">${body}</p><p><a href="https://jobs.mehyar.us/" style="color:#1a56db">← Back to mehyar.jobs</a></p></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
  if (!v) return html("Link expired", "This alert link isn't valid anymore. Manage your alerts from your profile page.");
  await ensureSchema(env);
  await env.JOBS_DB.prepare("UPDATE job_alert SET is_active = 0, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .bind(v.alertId, v.userId).run().catch(() => null);
  return html("Alert turned off", "You won't get emails for this search anymore. Your other alerts are untouched.");
}

// One free resume check per anonymous visitor (IP-hashed). No account.
async function handleFreeRun(request, env) {
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);
  const db = env.JOBS_DB;

  // Members (valid session/token) bypass the anonymous gate — unlimited via account.
  let member = null;
  try {
    const { requireUser } = await import("../../_shared/userAuth.js");
    const auth = await requireUser(request, env);
    if (auth?.ok) member = auth.user;
  } catch { /* anonymous */ }

  const ipHash = await clientIpHash(request, env);
  if (!member) {
    const usage = await anonUsage(db, ipHash, "check");
    if (usage.usedEver >= 1) {
      return json({
        ok: false, error: "free_run_used",
        message: "You've already used your free resume check. Create a free account for unlimited checks, AI resume tailoring, and new-match alerts.",
      }, 429, request, env);
    }
  }

  let body = {};
  try { body = await request.json(); } catch { /* fall through */ }
  const text = String(body.resume_text || "").slice(0, 12000);
  if (text.trim().length < 200) {
    return json({ ok: false, error: "resume_too_short", message: "Paste at least a few paragraphs of your resume (200+ characters)." }, 400, request, env);
  }

  const hints = {};
  if (typeof body.target_title === "string" && body.target_title.trim()) hints.target_titles = [body.target_title.trim().slice(0, 80)];
  if (typeof body.location === "string" && body.location.trim()) hints.locations = [body.location.trim().slice(0, 80)];
  const profile = deriveProfileFromResume(text, hints);

  const rows = await db.prepare(`
    SELECT j.id, j.title, j.description_text, j.location, j.remote_policy, j.employment_type,
           j.salary_min, j.salary_max, j.salary_currency, j.posted_at, j.url, c.industry
    FROM job j JOIN company c ON c.id = j.company_id
    WHERE j.is_active = 1
    ORDER BY j.first_seen_at DESC
    LIMIT 800
  `).all().catch(() => ({ results: [] }));
  const jobs = rows.results || [];

  const scored = [];
  // Without a detectable target title there are no title-match points, so a
  // slightly lower bar keeps keyword-strong jobs visible instead of "0 matches".
  const threshold = profile.target_titles && profile.target_titles.length ? 35 : 25;
  for (const row of jobs) {
    const out = scoreJob(row, profile, row.industry);
    if (out.score >= threshold && !out.hard_no) scored.push({ row, score: out.score, reasons: out.reasons, explain: out.explain });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 12).map((s) => ({
    id: s.row.id, title: s.row.title, url: s.row.url,
    company_name: null, company_industry: s.row.industry,
    location: s.row.location, remote_policy: s.row.remote_policy,
    employment_type: s.row.employment_type,
    salary_min: s.row.salary_min, salary_max: s.row.salary_max,
    salary_currency: s.row.salary_currency, posted_at: s.row.posted_at,
    score: s.score, reasons: s.reasons, explain: s.explain || [],
  }));
  // Attach company names for the top slice (one cheap query).
  if (top.length) {
    const ids = top.map((t) => t.id);
    const det = await db.prepare(`
      SELECT j.id, c.name AS company_name
      FROM job j JOIN company c ON c.id = j.company_id
      WHERE j.id IN (${ids.map(() => "?").join(",")})
    `).bind(...ids).all().catch(() => ({ results: [] }));
    const names = Object.fromEntries((det.results || []).map((r) => [r.id, r.company_name]));
    for (const t of top) t.company_name = names[t.id] || null;
  }

  if (!member) await recordAnonUse(db, ipHash, "check");

  return json({
    ok: true,
    profile: { target_titles: profile.target_titles, keywords: profile.keywords.slice(0, 15) },
    title_guessed: !!(profile.target_titles && profile.target_titles.length),
    matches: top,
    total_scored: jobs.length,
    free_runs_remaining: 0,
  }, 200, request, env);
}
