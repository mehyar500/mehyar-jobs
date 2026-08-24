const BODY_JOB_LIMIT = 75;
const CONTRACT_JOB_LIMIT = 25;

export function buildDailyJobsDigest(jobs, options = {}) {
  const scanDay = String(options.scanDay || new Date().toISOString().slice(0, 10));
  const appUrl = safeHttpUrl(options.appUrl || "https://jobs.mehyar.us", "https://jobs.mehyar.us");
  const scanStats = options.scanStats || {};
  const ranked = [...(jobs || [])].sort(compareJobs);
  const counts = summarizeJobs(ranked);
  const primary = ranked.slice(0, BODY_JOB_LIMIT);
  const primaryIds = new Set(primary.map((job) => Number(job.id)));
  const contractHighlights = ranked
    .filter((job) => job.employment_type === "contract" && !primaryIds.has(Number(job.id)))
    .slice(0, CONTRACT_JOB_LIMIT);
  const csv = buildJobsCsv(ranked);
  const subject = `mehyar.jobs: ${formatNumber(counts.total)} new jobs — ${formatNumber(counts.highFit)} strong matches, ${formatNumber(counts.contract)} contract`;

  const warningLines = scanWarnings(scanStats);
  const text = [
    `Daily job scan complete for ${scanDay} (UTC).`,
    "",
    `New jobs: ${formatNumber(counts.total)}`,
    `Strong matches (fit 70+): ${formatNumber(counts.highFit)}`,
    `Contract roles: ${formatNumber(counts.contract)}`,
    `Full-time roles: ${formatNumber(counts.fullTime)}`,
    `Remote roles: ${formatNumber(counts.remote)}`,
    ...(warningLines.length ? ["", ...warningLines] : []),
    "",
    `The attached CSV contains all ${formatNumber(counts.total)} new jobs, ordered by fit score.`,
    `Open today's jobs: ${appUrl}`,
    "",
    ...renderTextSection("BEST MATCHES", primary),
    ...renderTextSection("MORE CONTRACT OPPORTUNITIES", contractHighlights),
    "—",
    `mehyar.jobs · ${appUrl}`,
  ].join("\n");

  const html = renderHtml({
    scanDay,
    appUrl,
    counts,
    primary,
    contractHighlights,
    scanStats,
  });

  return {
    subject,
    text,
    html,
    csv,
    counts,
    attachment: {
      filename: `mehyar-jobs-${scanDay}.csv`,
      type: "text/csv",
      disposition: "attachment",
      content: csv,
    },
  };
}

export async function loadDailyJobs(db, digestRow, pageSize = 500) {
  if (!db) throw new Error("JOBS_DB missing");
  const size = Math.max(50, Math.min(1000, Number(pageSize) || 500));
  const jobs = [];
  let afterId = Math.max(0, Number(digestRow?.start_job_id || 0));
  const endJobId = Math.max(afterId, Number(digestRow?.end_job_id || afterId));
  const selectionMode = digestRow?.selection_mode === "utc_day" ? "utc_day" : "watermark";

  while (true) {
    const query = selectionMode === "utc_day"
      ? `
        SELECT ${JOB_SELECT}
        FROM job j
        JOIN company c ON c.id = j.company_id
        LEFT JOIN job_fit jf ON jf.job_id = j.id
        WHERE j.id > ?
          AND j.is_active = 1
          AND j.first_seen_at >= ?
          AND j.first_seen_at < datetime(?, '+1 day')
        ORDER BY j.id ASC
        LIMIT ?
      `
      : `
        SELECT ${JOB_SELECT}
        FROM job j
        JOIN company c ON c.id = j.company_id
        LEFT JOIN job_fit jf ON jf.job_id = j.id
        WHERE j.id > ?
          AND j.id <= ?
          AND j.is_active = 1
        ORDER BY j.id ASC
        LIMIT ?
      `;
    const result = selectionMode === "utc_day"
      ? await db.prepare(query).bind(afterId, digestRow.scan_day, digestRow.scan_day, size).all()
      : await db.prepare(query).bind(afterId, endJobId, size).all();
    const rows = result.results || [];
    if (!rows.length) break;
    jobs.push(...rows);
    afterId = Number(rows[rows.length - 1].id);
    if (rows.length < size || (selectionMode === "watermark" && afterId >= endJobId)) break;
  }

  return jobs;
}

export async function loadDailyScanStats(db, digestRow) {
  const stats = await db.prepare(`
    SELECT
      COALESCE(SUM(companies_attempted), 0) AS attempted,
      COALESCE(SUM(companies_succeeded), 0) AS succeeded,
      COALESCE(SUM(companies_failed), 0) AS failed
    FROM scrape_run
    WHERE started_at >= ?
      AND started_at <= ?
      AND trigger LIKE 'scheduled:%'
  `).bind(digestRow.scan_started_at, digestRow.scan_completed_at).first().catch(() => null);
  return {
    attempted: Number(stats?.attempted || 0),
    succeeded: Number(stats?.succeeded || 0),
    failed: Number(stats?.failed || 0),
    sourceSyncError: digestRow.source_sync_error || null,
  };
}

export function digestDisposition(row) {
  if (!row) return "missing";
  if (row.email_status === "sent") return "sent";
  if (row.email_status === "dead_letter") return "dead_letter";
  if (!row.scan_completed_at) return "scan_incomplete";
  if (row.email_status === "sending") return "in_progress";
  if (row.email_status === "failed" && row.email_next_attempt_at) return "retry_wait";
  return "claimable";
}

const JOB_SELECT = `
  j.id, j.title, j.url, j.location, j.remote_policy, j.employment_type,
  j.salary_min, j.salary_max, j.salary_currency, j.posted_at, j.first_seen_at,
  c.name AS company_name,
  COALESCE(jf.score, 0) AS score,
  COALESCE(jf.hard_no, 0) AS hard_no,
  jf.hard_no_reason
`;

function summarizeJobs(jobs) {
  return {
    total: jobs.length,
    highFit: jobs.filter((job) => !Number(job.hard_no) && Number(job.score || 0) >= 70).length,
    contract: jobs.filter((job) => job.employment_type === "contract").length,
    highFitContract: jobs.filter((job) => job.employment_type === "contract" && !Number(job.hard_no) && Number(job.score || 0) >= 70).length,
    fullTime: jobs.filter((job) => job.employment_type === "full_time").length,
    remote: jobs.filter((job) => job.remote_policy === "remote").length,
  };
}

function compareJobs(a, b) {
  const hardNo = Number(a.hard_no || 0) - Number(b.hard_no || 0);
  if (hardNo) return hardNo;
  const score = Number(b.score || 0) - Number(a.score || 0);
  if (score) return score;
  const posted = String(b.posted_at || b.first_seen_at || "").localeCompare(String(a.posted_at || a.first_seen_at || ""));
  if (posted) return posted;
  return Number(b.id || 0) - Number(a.id || 0);
}

function buildJobsCsv(jobs) {
  const columns = [
    ["fit_score", (job) => job.score],
    ["hard_filter", (job) => Number(job.hard_no) ? "yes" : "no"],
    ["employment_type", (job) => job.employment_type],
    ["company", (job) => job.company_name],
    ["title", (job) => job.title],
    ["location", (job) => job.location],
    ["remote_policy", (job) => job.remote_policy],
    ["salary_min", (job) => job.salary_min],
    ["salary_max", (job) => job.salary_max],
    ["salary_currency", (job) => job.salary_currency],
    ["posted_at", (job) => job.posted_at],
    ["first_seen_at", (job) => job.first_seen_at],
    ["url", (job) => job.url],
  ];
  const rows = [columns.map(([name]) => csvCell(name)).join(",")];
  for (const job of jobs) rows.push(columns.map(([, getter]) => csvCell(getter(job))).join(","));
  return `\uFEFF${rows.join("\r\n")}\r\n`;
}

function csvCell(value) {
  let text = value == null ? "" : String(value);
  if (/^[\t\r\n ]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function renderTextSection(label, jobs) {
  if (!jobs.length) return [];
  const lines = [`═══ ${label} ═══`];
  jobs.forEach((job, index) => {
    lines.push(`${index + 1}. ${job.title || "Untitled role"} @ ${job.company_name || "Unknown company"}`);
    lines.push(`   Fit ${Number(job.score || 0)}/100 · ${employmentLabel(job.employment_type)} · ${job.location || "Location not listed"}${job.remote_policy === "remote" ? " · Remote" : ""}${salaryLabel(job) ? ` · ${salaryLabel(job)}` : ""}`);
    lines.push(`   ${safeHttpUrl(job.url, "Link unavailable")}`);
  });
  lines.push("");
  return lines;
}

function renderHtml({ scanDay, appUrl, counts, primary, contractHighlights, scanStats }) {
  const warningLines = scanWarnings(scanStats);
  const countCard = (label, value) => `
    <td style="padding:12px 8px;text-align:center;border-right:1px solid #e4e4e7">
      <div style="font-size:22px;font-weight:700;color:#18181b">${formatNumber(value)}</div>
      <div style="font-size:12px;color:#71717a">${escapeHtml(label)}</div>
    </td>`;
  const section = (title, jobs) => jobs.length ? `
    <h2 style="font-size:18px;margin:28px 0 10px;color:#18181b">${escapeHtml(title)}</h2>
    <table role="presentation" style="width:100%;border-collapse:collapse;border:1px solid #e4e4e7;border-radius:10px">
      ${jobs.map(renderJobRow).join("")}
    </table>` : "";

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f4f4f5;color:#18181b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:720px;margin:0 auto;padding:24px 16px">
    <div style="background:#fff;border:1px solid #e4e4e7;border-radius:14px;padding:24px">
      <p style="margin:0 0 6px;color:#7c3aed;font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase">Daily scan complete · ${escapeHtml(scanDay)} UTC</p>
      <h1 style="font-size:26px;line-height:1.2;margin:0 0 10px">${formatNumber(counts.total)} new jobs found</h1>
      <p style="margin:0 0 20px;color:#52525b;line-height:1.5">The best matches are listed below. The attached CSV contains every new role from this scan, including full-time and contract jobs.</p>

      <table role="presentation" style="width:100%;border-collapse:collapse;background:#fafafa;border:1px solid #e4e4e7;border-radius:10px;overflow:hidden">
        <tr>
          ${countCard("Strong matches", counts.highFit)}
          ${countCard("Contract", counts.contract)}
          ${countCard("Full-time", counts.fullTime)}
          ${countCard("Remote", counts.remote)}
        </tr>
      </table>

      ${warningLines.length ? `<div style="margin-top:18px;padding:12px 14px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;color:#9a3412;font-size:13px">${warningLines.map(escapeHtml).join("<br>")}</div>` : ""}

      <p style="margin:20px 0">
        <a href="${escapeHtml(appUrl)}" style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;padding:11px 16px;border-radius:8px;font-weight:700">Open today's jobs →</a>
      </p>

      ${section(`Best ${primary.length} matches`, primary)}
      ${section("More contract opportunities", contractHighlights)}

      <p style="margin:28px 0 0;padding:14px;background:#f4f4f5;border-radius:8px;color:#52525b;font-size:13px;line-height:1.5">
        <strong>All ${formatNumber(counts.total)} jobs are attached as CSV.</strong><br>
        Sort or filter it by fit score, employment type, remote policy, salary, company, or location.
      </p>
      <hr style="border:0;border-top:1px solid #e4e4e7;margin:28px 0 18px">
      <p style="margin:0;color:#a1a1aa;font-size:12px">mehyar.jobs · <a href="${escapeHtml(appUrl)}" style="color:#7c3aed">${escapeHtml(appUrl)}</a></p>
    </div>
  </div>
</body></html>`;
}

function renderJobRow(job) {
  const url = safeHttpUrl(job.url, "https://jobs.mehyar.us");
  const tags = [employmentLabel(job.employment_type), job.remote_policy === "remote" ? "Remote" : null, salaryLabel(job)].filter(Boolean);
  return `<tr>
    <td style="padding:13px 12px;border-bottom:1px solid #e4e4e7">
      <a href="${escapeHtml(url)}" style="font-weight:700;color:#18181b;text-decoration:none">${escapeHtml(job.title || "Untitled role")}</a>
      <div style="margin-top:3px;color:#52525b;font-size:13px">${escapeHtml(job.company_name || "Unknown company")} · Fit ${Number(job.score || 0)}/100</div>
      <div style="margin-top:4px;color:#71717a;font-size:12px">${escapeHtml(job.location || "Location not listed")}${tags.length ? ` · ${tags.map(escapeHtml).join(" · ")}` : ""}</div>
    </td>
  </tr>`;
}

function scanWarnings(stats) {
  const lines = [];
  if (Number(stats?.failed || 0) > 0) lines.push(`Scan warning: ${formatNumber(Number(stats.failed))} company source${Number(stats.failed) === 1 ? "" : "s"} could not be refreshed and their previous jobs were preserved.`);
  if (stats?.sourceSyncError) {
    const degraded = /contract_source_(?:degraded|unavailable)|zero valid jobs/i.test(String(stats.sourceSyncError));
    lines.push(degraded
      ? "IMPORTANT — Contract feed unavailable: previous contract jobs were preserved, but today's email may be missing newly posted contract roles. Automatic retries will continue."
      : "Contract-source warning: one or more contract feed queries returned an error; available results are included.");
  }
  return lines;
}

function employmentLabel(value) {
  return ({ full_time: "Full-time", part_time: "Part-time", contract: "Contract", intern: "Internship" })[value] || "Type not listed";
}

function salaryLabel(job) {
  const min = job.salary_min == null || job.salary_min === "" ? Number.NaN : Number(job.salary_min);
  const max = job.salary_max == null || job.salary_max === "" ? Number.NaN : Number(job.salary_max);
  if (!Number.isFinite(min) && !Number.isFinite(max)) return "";
  const currency = job.salary_currency || "USD";
  const prefix = currency === "USD" ? "$" : `${currency} `;
  if (Number.isFinite(min) && Number.isFinite(max)) return `${prefix}${formatNumber(min)}–${prefix}${formatNumber(max)}`;
  if (Number.isFinite(min)) return `${prefix}${formatNumber(min)}+`;
  return `Up to ${prefix}${formatNumber(max)}`;
}

function safeHttpUrl(value, fallback) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Number(value || 0));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
