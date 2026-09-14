// _shared/sponsors.js
//
// Sponsor inventory helpers. Money comes only from employers/advertisers;
// every paid placement is labeled "Sponsored" at render time.

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// The currently active sponsor for a slot ('email' | 'matches'), or null.
export async function getActiveSponsor(db, slot) {
  if (!db) return null;
  const row = await db.prepare(`
    SELECT id, name, headline, body, cta_text, cta_url, slot, job_id
    FROM sponsor
    WHERE slot = ? AND is_active = 1
      AND (starts_at IS NULL OR starts_at <= datetime('now'))
      AND (ends_at   IS NULL OR ends_at   >= datetime('now'))
    ORDER BY id DESC
    LIMIT 1
  `).bind(slot).first().catch(() => null);
  return row || null;
}

// Email HTML block — clearly labeled "Sponsored".
export function sponsorEmailHtml(s) {
  if (!s) return "";
  return `
    <div style="margin:24px 0;padding:16px;border:1px dashed #d4a017;border-radius:8px;background:#fffbeb">
      <div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#b45309;margin-bottom:8px">Sponsored</div>
      <div style="font-weight:700;font-size:15px">${esc(s.headline)}</div>
      ${s.body ? `<div style="color:#57534e;font-size:13px;margin-top:4px">${esc(s.body)}</div>` : ""}
      <div style="margin-top:10px"><a href="${esc(s.cta_url)}" style="display:inline-block;background:#b45309;color:#fff;text-decoration:none;padding:8px 14px;border-radius:6px;font-size:13px;font-weight:600">${esc(s.cta_text || "Learn more")} →</a></div>
      <div style="color:#a8a29e;font-size:11px;margin-top:6px">Paid placement by ${esc(s.name)}</div>
    </div>`;
}

// Email plain-text block — clearly labeled "Sponsored".
export function sponsorEmailText(s) {
  if (!s) return [];
  return [
    ``,
    `── Sponsored ──`,
    s.headline,
    ...(s.body ? [s.body] : []),
    `${s.cta_text || "Learn more"}: ${s.cta_url}`,
    `Paid placement by ${s.name}`,
    ``,
  ];
}
