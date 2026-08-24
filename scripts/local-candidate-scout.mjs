import fs from "node:fs/promises";
import path from "node:path";
import { SEED_COMPANIES } from "../functions/_lib/data/seed_companies.js";
import { scrapeCompany } from "./scrapers/index.js";
import { scrapeYC, scrapeWellfound } from "../functions/_lib/scrapers/sources_extra.js";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const limit = Math.max(1, Number(args.limit || 200));
const output = path.resolve(root, args.output || "private/discovery/latest-matches.json");
const titlePattern = /\b(?:software engineer|software engineering|platform engineer|backend engineer|full.?stack engineer|automation engineer|ai engineer|ml engineer|machine learning engineer|research engineer|solutions architect|technical architect|forward deployed engineer|engineering manager)\b/i;
const excludedTitle = /\b(?:recruit|sales|account executive|marketing|finance|accounting|legal|security manager|customer success|program manager)\b/i;
const selected = SEED_COMPANIES.slice(0, limit);
const matches = [];
const failures = [];
let cursor = 0;
await Promise.all(Array.from({ length: Math.min(6, selected.length) }, async () => {
  while (cursor < selected.length) {
    const company = selected[cursor++];
    try {
      const result = await scrapeCompany(company, { now: new Date().toISOString() });
      if (!result.ok) { failures.push({ company: company.name, error: result.error || "unavailable" }); continue; }
      for (const job of result.items || []) if (isMatch(job)) matches.push({ company: company.name, source: company.careers_kind, title: job.title, location: job.location, remote_policy: job.remote_policy, url: job.url, posted_at: job.posted_at, description: (job.description_text || "").slice(0, 6000) });
    } catch (error) { failures.push({ company: company.name, error: String(error?.message || error) }); }
  }
}));
if (!args["no-extra-sources"]) {
  const extras = await Promise.allSettled([scrapeYC(), scrapeWellfound()]);
  for (const result of extras) {
    if (result.status !== "fulfilled") { failures.push({ company: "public_source", error: String(result.reason?.message || result.reason) }); continue; }
    const source = result.value;
    const names = new Map((source.companies || []).map((company) => [company.slug, company.name]));
    for (const job of source.jobs || []) if (isMatch(job)) matches.push({ company: names.get(job.company_slug) || job.company_slug || "Public source", source: "public_source", title: job.title, location: job.location, remote_policy: job.remote_policy, url: job.url, posted_at: job.posted_at, description: (job.description_text || "").slice(0, 6000) });
  }
}
matches.sort((a, b) => String(b.posted_at || "").localeCompare(String(a.posted_at || "")) || a.company.localeCompare(b.company));
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify({ generated_at: new Date().toISOString(), companies_checked: selected.length, matches, failures }, null, 2) + "\n");
console.log(JSON.stringify({ output: path.relative(root, output), companies_checked: selected.length, matching_links: matches.length, failures: failures.length }, null, 2));

function isMatch(job) {
  const title = String(job.title || "");
  const location = `${job.location || ""} ${job.remote_policy || ""}`.toLowerCase();
  const locationOk = !location || /remote|new york|nyc|brooklyn|hybrid/.test(location);
  return locationOk && titlePattern.test(title) && !excludedTitle.test(title);
}
function parseArgs(items) { const out = {}; for (let i = 0; i < items.length; i++) if (items[i].startsWith("--")) out[items[i].slice(2)] = items[i + 1]?.startsWith("--") ? true : items[++i]; return out; }
