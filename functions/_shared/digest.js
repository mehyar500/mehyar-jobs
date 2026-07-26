// _shared/digest.js
//
// Daily activity digest: aggregates all the day's submitted + confirmed
// applications into a single email body. The cron worker calls
// `buildDigest({env, daysBack: 1})` and emails the result.
//
//   sections:
//   - Hero number: submitted_today, confirmed_today, awaiting_company (3+ days)
//   - Per-app list: title, company, submitted time, confirmation status,
//     tracking email, company email subject (if confirmed)
//   - Recommended action: which apps need a manual click on the
//     company page to finalize, and which need a follow-up ping

export async function buildDigest(env, { daysBack = 1, profile } = {}) {
  const db = env.JOBS_DB;
  if (!db) throw new Error("JOBS_DB missing");
  const sinceClause = `datetime('now', '-${Math.max(1, daysBack)} days')`;

  const submitted = (await db.prepare(`
    SELECT
      a.id, a.status, a.submitted_at, a.company_confirmed_at,
      a.company_confirmed_source, a.company_email_subject, a.tracking_email,
      a.submission_url, a.follow_up_count,
      j.title AS job_title, j.url AS job_url, j.location AS job_location,
      j.remote_policy AS job_remote_policy, j.score AS job_score,
      c.id AS company_id, c.name AS company_name, c.careers_url AS company_careers_url
    FROM application a
    JOIN job j     ON j.id = a.job_id
    JOIN company c ON c.id = j.company_id
    WHERE a.submitted_at IS NOT NULL
      AND a.submitted_at >= ${sinceClause}
    ORDER BY a.submitted_at DESC
  `).all().catch(() => ({ results: [] }))).results || [];

  const confirmed = submitted.filter((a) => !!a.company_confirmed_at);
  const awaiting = (await db.prepare(`
    SELECT
      a.id, a.status, a.submitted_at, a.tracking_email, a.submission_url,
      j.title AS job_title,
      c.name AS company_name, c.careers_url AS company_careers_url,
      CAST(julianday('now') - julianday(a.submitted_at) AS INTEGER) AS days_waiting
    FROM application a
    JOIN job j     ON j.id = a.job_id
    JOIN company c ON c.id = j.company_id
    WHERE a.status = 'submitted'
      AND a.company_confirmed_at IS NULL
      AND a.submitted_at IS NOT NULL
      AND julianday('now') - julianday(a.submitted_at) >= 3
    ORDER BY a.submitted_at ASC
  `).all().catch(() => ({ results: [] }))).results || [];

  const drafts = (await db.prepare(`
    SELECT COUNT(*) AS n FROM application WHERE status = 'draft'
  `).first().catch(() => ({ n: 0 }))).n || 0;

  const newJobs = (await db.prepare(`
    SELECT COUNT(*) AS n FROM job WHERE is_active = 1 AND first_seen_at >= ${sinceClause}
  `).first().catch(() => ({ n: 0 }))).n || 0;

  // Build the email
  const subject = `📊 mehyar.jobs digest — ${submitted.length} submitted, ${confirmed.length} confirmed today`;
  const lines = [
    `Hi,`,
    ``,
    `Here is your mehyar.jobs activity for the last ${daysBack} day${daysBack === 1 ? "" : "s"}:`,
    ``,
    `📨 Submitted:   ${submitted.length}`,
    `✅ Confirmed:   ${confirmed.length} (from the company)`,
    `⏳ Awaiting reply: ${awaiting.length} (3+ days since submit, no confirmation)`,
    `📝 Drafts:      ${drafts} (ready when you are)`,
    `🆕 New jobs:    ${newJobs} (found since last digest)`,
    ``,
  ];
  if (submitted.length) {
    lines.push(`═══ SUBMITTED ═══`);
    for (const a of submitted) {
      const days = a.submitted_at ? Math.floor((Date.now() - Date.parse(a.submitted_at)) / 86400000) : 0;
      const status = a.company_confirmed_at
        ? `✅ confirmed ${a.company_confirmed_source || ""}`
        : `⏳ awaiting reply (${days}d)`;
      lines.push(`  ${status}  ${a.job_title} @ ${a.company_name}`);
      lines.push(`    Fit ${a.job_score || "—"}/100 · ${a.job_location || ""}${a.job_remote_policy && a.job_remote_policy !== "unknown" ? " · " + a.job_remote_policy : ""}`);
      lines.push(`    Tracking: ${a.tracking_email || "—"}${a.company_email_subject ? `  ·  Subject: "${a.company_email_subject}"` : ""}`);
      if (a.submission_url) lines.push(`    ${a.submission_url}`);
      lines.push(``);
    }
  }
  if (awaiting.length) {
    lines.push(`═══ AWAITING REPLY (3+ days) — consider following up ═══`);
    for (const a of awaiting) {
      lines.push(`  ⏰ ${a.days_waiting}d  ${a.job_title} @ ${a.company_name}`);
      lines.push(`    Open: ${a.careers_url || a.submission_url || "—"}`);
    }
    lines.push(``);
  }
  if (drafts > 0) {
    lines.push(`═══ NEXT ═══`);
    lines.push(`You have ${drafts} draft application${drafts === 1 ? "" : "s"} ready. Visit https://jobs.mehyar.us to review and submit.`);
    lines.push(``);
  }
  lines.push(`—`);
  lines.push(`mehyar.jobs · https://jobs.mehyar.us · daily digest`);

  const text = lines.join("\n");
  const html = renderHtml({ submitted, confirmed, awaiting, drafts, newJobs, daysBack });
  return { subject, text, html, counts: { submitted: submitted.length, confirmed: confirmed.length, awaiting: awaiting.length, drafts, newJobs } };
}

function renderHtml({ submitted, confirmed, awaiting, drafts, newJobs, daysBack }) {
  const row = (label, value) => `<tr><td style="padding:6px 12px 6px 0;color:#71717a">${label}</td><td style="padding:6px 0;font-weight:600">${value}</td></tr>`;
  const submittedRows = submitted.map((a) => {
    const days = a.submitted_at ? Math.floor((Date.now() - Date.parse(a.submitted_at)) / 86400000) : 0;
    const status = a.company_confirmed_at
      ? `<span style="background:rgba(16,185,129,.15);color:#10b981;padding:2px 8px;border-radius:4px">✅ confirmed</span>`
      : `<span style="background:rgba(245,158,11,.15);color:#f59e0b;padding:2px 8px;border-radius:4px">⏳ ${days}d no reply</span>`;
    return `
      <tr>
        <td style="padding:12px;border-bottom:1px solid #e4e4e7">
          ${status}
          <div style="font-weight:600;margin-top:4px">${escapeHtml(a.job_title)}</div>
          <div style="color:#71717a;font-size:13px">${escapeHtml(a.company_name)} · Fit ${a.job_score || "—"}/100</div>
          ${a.company_email_subject ? `<div style="color:#71717a;font-size:12px;margin-top:4px">Subject: &quot;${escapeHtml(a.company_email_subject)}&quot;</div>` : ""}
          <div style="margin-top:6px"><a href="${escapeHtml(a.submission_url || a.job_url || "#")}" style="color:#7c3aed;font-size:13px">Open job →</a></div>
        </td>
      </tr>`;
  }).join("");
  const awaitingRows = awaiting.map((a) => `
    <tr>
      <td style="padding:12px;border-bottom:1px solid #e4e4e7;background:rgba(245,158,11,.05)">
        <div style="color:#f59e0b;font-size:13px">⏰ ${a.days_waiting}d no reply</div>
        <div style="font-weight:600;margin-top:2px">${escapeHtml(a.job_title)} @ ${escapeHtml(a.company_name)}</div>
        <a href="${escapeHtml(a.careers_url || a.submission_url || "#")}" style="color:#7c3aed;font-size:12px">Open careers page →</a>
      </td>
    </tr>`).join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#18181b">
  <h1 style="font-size:22px;margin:0 0 8px">📊 Daily digest</h1>
  <p style="color:#71717a;margin:0 0 24px">mehyar.jobs activity for the last ${daysBack} day${daysBack === 1 ? "" : "s"}</p>

  <div style="background:#f4f4f5;border-radius:12px;padding:16px;margin-bottom:24px">
    <table style="border-collapse:collapse">
      ${row("📨 Submitted today", submitted.length)}
      ${row("✅ Confirmed by company", confirmed.length)}
      ${row("⏳ Awaiting reply (3d+)", awaiting.length)}
      ${row("📝 Drafts ready", drafts)}
      ${row("🆕 New jobs found", newJobs)}
    </table>
  </div>

  ${submitted.length ? `
    <h2 style="font-size:17px;margin:24px 0 8px">📨 Submitted</h2>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e4e4e7;border-radius:8px;overflow:hidden">${submittedRows}</table>
  ` : ""}

  ${awaiting.length ? `
    <h2 style="font-size:17px;margin:24px 0 8px">⏰ Awaiting reply (consider following up)</h2>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e4e4e7;border-radius:8px;overflow:hidden">${awaitingRows}</table>
  ` : ""}

  ${drafts > 0 ? `
    <p style="margin-top:24px;padding:16px;background:rgba(124,58,237,.08);border-radius:8px">
      📝 You have <strong>${drafts}</strong> draft application${drafts === 1 ? "" : "s"} ready to submit. <a href="https://jobs.mehyar.us/applications" style="color:#7c3aed;font-weight:600">Review now →</a>
    </p>
  ` : ""}

  <hr style="border:none;border-top:1px solid #e4e4e7;margin:32px 0">
  <p style="color:#a1a1aa;font-size:12px;margin:0">
    mehyar.jobs · <a href="https://jobs.mehyar.us" style="color:#a1a1aa">jobs.mehyar.us</a> · daily digest
  </p>
</body></html>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[c]);
}
