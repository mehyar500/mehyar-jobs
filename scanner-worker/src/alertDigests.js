// scanner-worker/src/alertDigests.js
//
// Free job alerts: every saved search gets an email with only the NEW jobs
// matching its filters since the last send. Watermark-based (last_sent_at),
// so each posting alerts at most once per alert.
//
// Runs inside the scheduled worker (has D1 + send_email). Bounded: at most
// ALERTS_PER_RUN alerts per cron invocation.

import { getUserFitProfile, signUnsubscribeToken, signAlertToken } from "../../functions/_shared/userAuth.js";
import { scoreJob } from "../../functions/_shared/fit.js";
import { getActiveSponsor, sponsorEmailHtml, sponsorEmailText } from "../../functions/_shared/sponsors.js";
import { getOfferSlots, getFeaturedOfferSlot, offerEmailHtml, offerEmailText } from "../../functions/_shared/sms.js";

const ALERTS_PER_RUN = 50;
const MATCHES_PER_EMAIL = 12;

function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildWhere(filters) {
  const where = ["j.is_active = 1"];
  const binds = [];
  if (filters.q) {
    where.push("(j.title LIKE ? OR j.description_text LIKE ? OR c.name LIKE ?)");
    binds.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`);
  }
  if (filters.industry) { where.push("c.industry = ?"); binds.push(filters.industry); }
  if (filters.location) { where.push("j.location LIKE ?"); binds.push(`%${filters.location}%`); }
  if (filters.remote) { where.push("j.remote_policy = ?"); binds.push(filters.remote); }
  if (filters.employment_type) { where.push("j.employment_type = ?"); binds.push(filters.employment_type); }
  return { where: where.join(" AND "), binds };
}

async function buildAlertEmail(alert, matches, appUrl, env, user) {
  const subject = `🔔 ${matches.length} new ${matches.length === 1 ? "job" : "jobs"}: ${alert.name}`;
  let sponsor = null;
  try { sponsor = await getActiveSponsor(env?.JOBS_DB, "email"); } catch { /* sponsor is optional */ }
  let offer = null;
  try { offer = getFeaturedOfferSlot(await getOfferSlots(env?.JOBS_DB)); } catch { /* offer is optional */ }
  let offUrl = `${appUrl}/profile`;
  try {
    const token = await signAlertToken(alert.id, alert.user_id, env);
    offUrl = `${appUrl}/api/public/alert-off?token=${encodeURIComponent(token)}`;
  } catch { /* one-click off is best-effort */ }
  let unsubUrl = `${appUrl}/unsubscribe`;
  try {
    const token = await signUnsubscribeToken(user.email, env);
    unsubUrl = `${appUrl}/unsubscribe?token=${encodeURIComponent(token)}`;
  } catch { /* best-effort */ }

  const rows = matches.map((m, i) => {
    const salary = m.salary_min || m.salary_max
      ? ` · $${Number(m.salary_min || 0).toLocaleString()}${m.salary_max ? `–$${Number(m.salary_max).toLocaleString()}` : ""}`
      : "";
    const score = m.score != null ? ` (${m.score}/100)` : "";
    return `${i + 1}. ${m.title} — ${m.company_name}${score}${salary}\n   ${m.location || ""}${m.remote_policy === "remote" ? " · remote" : ""}\n   ${m.url}`;
  });
  const text = [
    `Hi ${user.display_name || "there"},`,
    ``,
    `New jobs for your alert "${alert.name}":`,
    ``,
    ...rows,
    ``,
    `Browse them all: ${appUrl}/`,
    `Turn off this alert (one click, no login): ${offUrl}`,
    `Unsubscribe from all emails: ${unsubUrl}`,
    ...sponsorEmailText(sponsor),
    ...offerEmailText(offer, appUrl),
    `— mehyar.jobs`,
  ].join("\n");

  const htmlRows = matches.map((m) => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #eee">
        <a href="${esc(m.url)}" style="font-weight:600;color:#1a56db">${esc(m.title)}</a>
        <span style="color:#666"> — ${esc(m.company_name)}</span>
        ${m.score != null ? `<span style="display:inline-block;background:#eef2ff;color:#3730a3;border-radius:999px;padding:1px 8px;font-size:12px;margin-left:6px">${m.score}/100</span>` : ""}
        <div style="color:#666;font-size:13px">${esc(m.location || "")}${m.remote_policy === "remote" ? " · remote" : ""}</div>
      </td>
    </tr>`).join("");

  const html = `
    <p>Hi ${esc(user.display_name || "there")},</p>
    <p><strong>${matches.length}</strong> new ${matches.length === 1 ? "job" : "jobs"} for your alert <strong>“${esc(alert.name)}”</strong>:</p>
    <table style="width:100%;border-collapse:collapse">${htmlRows}</table>
    ${sponsorEmailHtml(sponsor)}
    ${offerEmailHtml(offer, appUrl)}
    <p style="color:#888;font-size:12px"><a href="${esc(offUrl)}" style="color:#888">Turn off this alert</a> · <a href="${esc(unsubUrl)}" style="color:#888">Unsubscribe from all emails</a> · — mehyar.jobs</p>`;
  return { subject, text, html };
}

export async function deliverJobAlerts(env, scanDay) {
  const db = env.JOBS_DB;
  if (!db) return { ok: false, error: "no_db" };
  if (!env.EMAIL || typeof env.EMAIL.send !== "function") {
    return { ok: false, error: "EMAIL binding missing" };
  }
  const appUrl = env.JOBS_APP_URL || "https://jobs.mehyar.us";
  const sender = env.DIGEST_FROM_EMAIL || "noreply@mehyar.us";

  const alerts = await db.prepare(`
    SELECT a.id, a.user_id, a.name, a.filters_json, a.last_sent_at,
           u.email, u.display_name
    FROM job_alert a
    JOIN app_user u ON u.id = a.user_id
    WHERE a.is_active = 1 AND u.email IS NOT NULL AND u.email != ''
    ORDER BY a.id ASC
    LIMIT ?
  `).bind(ALERTS_PER_RUN).all().catch(() => ({ results: [] }));
  const list = alerts.results || [];
  if (!list.length) return { ok: true, sent: 0 };

  const outcome = { ok: true, sent: 0, skipped_no_matches: 0, errors: [] };
  const nowSql = "datetime('now')";

  for (const alert of list) {
    try {
      const filters = JSON.parse(alert.filters_json || "{}");
      const { where, binds } = buildWhere(filters);
      const since = alert.last_sent_at || "datetime('now', '-1 day')";

      const rows = await db.prepare(`
        SELECT j.id, j.title, j.url, j.location, j.remote_policy, j.employment_type,
               j.salary_min, j.salary_max, j.salary_currency, j.posted_at,
               j.first_seen_at, j.description_text,
               c.name AS company_name, c.industry AS company_industry
        FROM job j JOIN company c ON c.id = j.company_id
        WHERE ${where} AND j.first_seen_at > ${alert.last_sent_at ? "?" : since}
        ORDER BY j.first_seen_at DESC
        LIMIT 40
      `).bind(...binds, ...(alert.last_sent_at ? [alert.last_sent_at] : [])).all().catch(() => ({ results: [] }));
      let matches = rows.results || [];

      // Rank by fit when the user has a profile; otherwise newest first.
      let profile = null;
      try { profile = await getUserFitProfile(env, alert.user_id); } catch { /* optional */ }
      if (profile && (profile.keywords?.length || profile.target_titles?.length)) {
        matches = matches.map((m) => {
          const s = scoreJob(
            { title: m.title, description_text: m.description_text, location: m.location, remote_policy: m.remote_policy, salary_min: m.salary_min, salary_max: m.salary_max, posted_at: m.posted_at },
            profile, m.company_industry
          );
          return { ...m, score: s.score };
        }).sort((a, b) => b.score - a.score);
      }
      const top = matches.slice(0, MATCHES_PER_EMAIL);

      if (!top.length) {
        // Nothing new — advance the watermark so we don't rescan the
        // same window forever, and count it as skipped.
        await db.prepare(`UPDATE job_alert SET last_sent_at = ${nowSql}, last_match_count = 0, updated_at = ${nowSql} WHERE id = ?`)
          .bind(alert.id).run().catch(() => null);
        outcome.skipped_no_matches += 1;
        continue;
      }

      const email = await buildAlertEmail(alert, top, appUrl, env, alert);
      await env.EMAIL.send({
        to: alert.email,
        from: { email: sender, name: "mehyar.jobs" },
        replyTo: env.DIGEST_REPLY_TO || "info@mehyar.us",
        subject: email.subject,
        text: email.text,
        html: email.html,
        headers: { "X-Campaign-ID": `job-alert-${alert.id}-${scanDay}` },
      });
      // Watermark advances ONLY after a successful send — if EMAIL.send
      // throws, the same matches retry on the next run instead of being
      // silently dropped.
      await db.prepare(`UPDATE job_alert SET last_sent_at = ${nowSql}, last_match_count = ?, updated_at = ${nowSql} WHERE id = ?`)
        .bind(top.length, alert.id).run().catch(() => null);
      outcome.sent += 1;
    } catch (e) {
      outcome.errors.push({ alert: alert.id, error: String(e?.message || e).slice(0, 200) });
    }
  }
  console.log(JSON.stringify({ event: "job_alerts_delivered", scan_day: scanDay, ...outcome, errors: outcome.errors.length }));
  return outcome;
}
