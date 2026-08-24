import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const input = path.resolve(root, args.input || "private/discovery/latest-matches.json");
const output = path.resolve(root, args.output || "private/discovery/scored-top-20.json");
const max = Math.max(1, Math.min(100, Number(args.max || 20)));
const data = JSON.parse(await fs.readFile(input, "utf8"));
const unique = Array.from(new Map((data.matches || []).filter((job) => job.url).map((job) => [job.url.replace(/[?&]gh_jid=\d+/, ""), job])).values());
const scored = unique.map((job) => ({ ...job, score: score(job), reasons: reasons(job) }))
  .filter((job) => job.score >= 45)
  .sort((a, b) => b.score - a.score || String(b.posted_at || "").localeCompare(String(a.posted_at || "")))
  .slice(0, max);
await fs.writeFile(output, JSON.stringify({ generated_at: new Date().toISOString(), source_matches: data.matches?.length || 0, items: scored }, null, 2) + "\n");
console.log(JSON.stringify({ output: path.relative(root, output), scored: scored.length, top: scored.map(({ company, title, score }) => ({ company, title, score })) }, null, 2));

function score(job) {
  const title = String(job.title || "").toLowerCase();
  const text = `${title} ${job.description || ""}`.toLowerCase();
  const location = `${job.location || ""} ${job.remote_policy || ""}`.toLowerCase();
  let score = 0;
  if (/staff|senior|principal|lead|manager/.test(title)) score += 18;
  if (/software engineer|backend engineer|platform engineer|full.?stack engineer|solutions architect|forward deployed engineer|engineering manager/.test(title)) score += 32;
  for (const keyword of ["typescript", "react", "node", "python", "api", "platform", "cloud", "aws", "gcp", "kubernetes", "rag", "llm", "ai", "automation", "data pipeline"]) if (text.includes(keyword)) score += 2;
  if (/remote|new york|nyc|brooklyn|hybrid/.test(location)) score += 20;
  if (/intern|junior|new grad|sales|recruit|marketing|finance|accounting/.test(title)) score -= 60;
  if (/security|machine learning/.test(title) && !/software engineer|forward deployed/.test(title)) score -= 10;
  return Math.max(0, Math.min(100, score));
}
function reasons(job) { return [`title: ${job.title}`, `location: ${job.location || job.remote_policy || "unspecified"}`]; }
function parseArgs(items) { const out = {}; for (let i = 0; i < items.length; i++) if (items[i].startsWith("--")) out[items[i].slice(2)] = items[i + 1]?.startsWith("--") ? true : items[++i]; return out; }
