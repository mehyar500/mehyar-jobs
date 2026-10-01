// scripts/warmup-select.mjs
// Select recipients for one day of the mehyar.jobs warmup campaign.
// Read-only against production D1 (SELECTs only). Never re-sends.
//
// Usage: node scripts/warmup-select.mjs --day N [--json]
//   Prints the day's selection + the SQL to seed the warmup_campaign_daily row.
//
// Volume schedule (Fibonacci-ish, capped at Brevo's 300/day free limit):
//   day 1=5, 2=10, then day[N]=day[N-1]+day[N-2], cap 300.
import { execFileSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const WR = ["python3", "/home/hatch/workspace/skills/cloudflare/bin/wr.py"];
const WR_ARGS = ["d1", "execute", "mehyar-jobs", "--remote", "--config", "scanner-worker/wrangler.toml", "--command"];

export function volumeForDay(n) {
  if (n <= 0) return 0;
  if (n === 1) return 5;
  if (n === 2) return 10;
  let a = 5, b = 10;
  for (let i = 3; i <= n; i++) { const c = Math.min(300, a + b); a = b; b = c; }
  return b;
}

function d1Select(sql) {
  const out = execFileSync(WR[0], [...WR.slice(1), ...WR_ARGS, sql], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120000,
  });
  // wrangler prints logs then a final JSON array of {results:[...]} blocks.
  const m = out.match(/\[[\s\S]*\]\s*$/);
  if (!m) throw new Error("could not parse wr.py output");
  const blocks = JSON.parse(m[0]);
  return blocks.flatMap((b) => b.results || []);
}

const OUTLOOK_RES = new Set(["outlook.com", "hotmail.com", "live.com", "msn.com"]);

export function selectRecipients(day, volumeOverride = null) {
  const volume = volumeOverride ?? volumeForDay(day);
  const rows = d1Select(`
    SELECT ec.email, ec.first_name
    FROM email_contact ec
    WHERE ec.source = 'legacy'
      AND ec.brand = 'mehyar.jobs'
      AND ec.status NOT IN ('opted_out', 'bounced', 'complained')
      AND ec.email NOT IN (SELECT recipient_email FROM warmup_campaign_sends)
    ORDER BY
      CASE WHEN ec.email LIKE '%@gmail.com' THEN 0 ELSE 1 END,
      ec.id ASC
  `);
  const outlookMax = Math.max(1, Math.floor(volume * 0.25));
  const picked = [];
  let outlookUsed = 0, skippedOutlook = 0;
  for (const r of rows) {
    if (picked.length >= volume) break;
    const domain = String(r.email).split("@")[1]?.toLowerCase() || "";
    if (OUTLOOK_RES.has(domain)) {
      if (outlookUsed >= outlookMax) { skippedOutlook++; continue; }
      outlookUsed++;
    }
    picked.push({ email: r.email, first_name: r.first_name || "" });
  }
  // Backfill: if Outlook cap left seats empty and Gmail pool is exhausted,
  // allow Outlook over the cap rather than undersending (still no re-sends).
  if (picked.length < volume && skippedOutlook > 0) {
    for (const r of rows) {
      if (picked.length >= volume) break;
      if (picked.some((p) => p.email === r.email)) continue;
      picked.push({ email: r.email, first_name: r.first_name || "" });
    }
  }
  return {
    day, volume,
    selected: picked,
    shortfall: Math.max(0, volume - picked.length),
    pool_size: rows.length,
  };
}

export function dailyRowSQL(day, volume, dateStr) {
  const d = dateStr || new Date().toISOString().slice(0, 10);
  return `INSERT INTO warmup_campaign_daily (brand, campaign_day, date, planned_volume, sent_count, delivered_count, open_count, click_count, bounce_count, unsub_count) VALUES ('mehyar.jobs', ${day}, '${d}', ${volume}, 0, 0, 0, 0, 0, 0) ON CONFLICT(brand, campaign_day) DO UPDATE SET planned_volume = excluded.planned_volume;`;
}

const args = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  const dayIdx = args.indexOf("--day");
  const day = dayIdx >= 0 ? parseInt(args[dayIdx + 1], 10) : 1;
  if (!day || day < 1) { console.error("usage: node scripts/warmup-select.mjs --day N [--json]"); process.exit(2); }
  const sel = selectRecipients(day);
  if (args.includes("--json")) {
    console.log(JSON.stringify(sel, null, 1));
  } else {
    console.log(`day ${sel.day}: volume ${sel.volume}, pool ${sel.pool_size}, selected ${sel.selected.length}, shortfall ${sel.shortfall}`);
    for (const s of sel.selected) console.log(`  ${s.email}${s.first_name ? ` (${s.first_name})` : ""}`);
    if (sel.shortfall > 0) console.log(`PAUSE SIGNAL: pool short by ${sel.shortfall} — top up via sync-legacy-cohort.mjs --live`);
    console.log("daily row SQL:\n" + dailyRowSQL(sel.day, sel.volume));
  }
  process.exit(0);
}
