import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const input = path.resolve(root, args.input || "private/discovery/scored-top-20.json");
const target = Math.max(1, Math.min(10, Number(args.target || 10)));
const fitMin = Math.max(0, Math.min(100, Number(args["fit-min"] || 70)));
const headless = args.headless !== "false";
const preferAts = String(args.ats || "").toLowerCase();
const profilePath = path.join(root, "private", "mehyar-swelim-application-profile.md");
const profileText = await fs.readFile(profilePath, "utf8");
const profile = parseProfile(profileText);
await fs.access(profile.resumePath);

const data = JSON.parse(await fs.readFile(input, "utf8"));
const seenPath = path.join(root, "private", "runs", "submitted-urls.json");
const seen = await readSeen(seenPath);
const attemptedPath = path.join(root, "private", "runs", "attempted-urls.json");
const attempted = await readSeen(attemptedPath);
const jobs = (data.items || [])
  .filter((job) => Number(job.score || 0) >= fitMin)
  .filter((job) => supported(job.url))
  .filter((job) => !preferAts || String(job.url || "").toLowerCase().includes(preferAts))
  .filter((job) => locationOk(job))
  .filter((job) => !seen.urls.includes(normalizeUrl(job.url)))
  .filter((job) => !attempted.urls.includes(normalizeUrl(job.url)))
  .slice(0, target);

const startedAt = new Date().toISOString();
const runId = startedAt.replace(/[:.]/g, "-");
const summaryDir = path.join(root, "private", "runs", "daily-discovery", runId);
await fs.mkdir(summaryDir, { recursive: true });

const results = [];
let submitted = 0;
for (let i = 0; i < jobs.length; i++) {
  const job = jobs[i];
  const materialPath = await writeMaterial(job, profile, summaryDir, i + 1);
  const result = await runWorker(job, materialPath);
  if (!attempted.urls.includes(normalizeUrl(job.url))) {
    attempted.urls.push(normalizeUrl(job.url));
    await fs.mkdir(path.dirname(attemptedPath), { recursive: true });
    await fs.writeFile(attemptedPath, JSON.stringify(attempted, null, 2) + "\n", "utf8");
  }
  if (result.outcome === "submitted") {
    submitted++;
    seen.urls.push(normalizeUrl(job.url));
    await fs.mkdir(path.dirname(seenPath), { recursive: true });
    await fs.writeFile(seenPath, JSON.stringify(seen, null, 2) + "\n", "utf8");
  }
  results.push({
    company: job.company,
    title: job.title,
    score: job.score,
    location: job.location,
    url: job.url,
    outcome: result.outcome,
    audit: result.audit,
    error: result.error || null,
  });
}

const summary = {
  ok: true,
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  target,
  fit_min: fitMin,
  candidates_found: jobs.length,
  attempted: results.length,
  submitted,
  needs_user_action: results.filter((r) => r.outcome === "needs_user_action").length,
  failed: results.filter((r) => r.outcome === "failed").length,
  results,
};
const summaryPath = path.join(summaryDir, "summary.json");
await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ ...summary, summary: path.relative(root, summaryPath) }, null, 2));

async function writeMaterial(job, profile, dir, index) {
  const material = {
    cover_letter: coverLetter(job, profile),
    answers: [
      { question: "Why are you interested in this role?", answer: `This role maps directly to my work across production software, applied AI, platform architecture, and automation. ${job.company}'s posting emphasizes the kind of reliable systems work I want to keep doing.` },
      { question: "Why this company?", answer: `${job.company} is working in an area where strong engineering execution matters. The scope in this posting lines up with my background in shipping production systems, APIs, cloud infrastructure, and AI-enabled workflows.` },
      { question: "Work authorization", answer: profile.workAuth || "Authorized to work in the United States; no sponsorship needed at this time." },
      { question: "Salary expectations", answer: profile.salary || "Open to discussing compensation once the role scope is clear." },
      { question: "Location", answer: profile.location },
      { question: "LinkedIn", answer: profile.linkedin },
      { question: "Website", answer: profile.website },
    ].filter((item) => item.answer),
    facts_used: [
      profile.fullName,
      profile.location,
      profile.email,
      profile.linkedin,
      profile.website,
      "private application profile",
      "local resume source",
      `${job.company} ${job.title}`,
    ].filter(Boolean),
    needs_review: [],
  };
  const safeName = `${String(index).padStart(2, "0")}-${slug(job.company)}-${slug(job.title)}.json`;
  const file = path.join(dir, safeName);
  await fs.writeFile(file, JSON.stringify(material, null, 2) + "\n", "utf8");
  return path.relative(root, file);
}

function runWorker(job, materialPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      "scripts/local-application-worker.mjs",
      "--job-url", job.url,
      "--title", job.title,
      "--company", job.company,
      "--material", materialPath,
      "--mode", "submit",
      "--confirm", "APPLY",
      "--headless", String(headless),
    ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", () => {
      const match = output.match(/\{[\s\S]*\}\s*$/);
      let data = {};
      try { data = match ? JSON.parse(match[0]) : {}; } catch {}
      resolve({
        outcome: data.outcome || "failed",
        audit: data.audit || null,
        error: data.error || (data.outcome ? null : output.trim().slice(-500)),
      });
    });
  });
}

function coverLetter(job, profile) {
  return `Hi ${job.company} team,

I am applying for the ${job.title} role. The match is strong: the work connects directly to my background in production software engineering, applied AI, automation, cloud delivery, APIs, TypeScript, Python, and operationally reliable systems.

I have spent more than 15 years building and shipping systems across software, healthcare, analytics, and AI products. Most recently, my work has focused on AI voice platforms, RAG systems, automation, and practical product infrastructure. I am strongest where the job is not just writing code, but turning ambiguous requirements into something dependable that users and teams can actually rely on.

This role stood out because it calls for the kind of ownership I want: deep technical execution, cross-functional judgment, and enough product context to build the right thing instead of only the requested thing.

Mehyar Swelim`;
}

function parseProfile(text) {
  const val = (name) => (text.match(new RegExp(`^- ${name}:\\s*(.+)$`, "mi")) || [])[1]?.replace(/`/g, "").trim() || "";
  return {
    fullName: val("Full name"),
    email: val("Email"),
    phone: val("Phone"),
    location: val("Location"),
    website: val("Website"),
    linkedin: val("LinkedIn"),
    resumePath: val("Resume source"),
    workAuth: findAnswer(text, /authorized|work authorization|sponsorship/i),
    salary: findAnswer(text, /salary|compensation/i),
  };
}

function findAnswer(text, pattern) {
  const lines = text.split(/\r?\n/);
  const idx = lines.findIndex((line) => pattern.test(line));
  if (idx === -1) return "";
  return lines.slice(idx, idx + 4).join(" ").replace(/^[-#\s]+/, "").trim().slice(0, 600);
}

function locationOk(job) {
  const location = String(job.location || "").toLowerCase();
  const url = String(job.url || "").toLowerCase();
  if (/india|ireland|london|canada|emea|europe|bengaluru|bangalore|karnataka|telangana|maharashtra|new delhi/.test(location)) return false;
  return /remote|united states|us remote|remote - us|new york|nyc|brooklyn|austin|miami|hybrid|san francisco|seattle/.test(location)
    || /ashbyhq\.com\/(openai|perplexity|pinecone)/.test(url);
}

function supported(url) {
  return /(job-boards\.greenhouse\.io|boards\.greenhouse\.io|ashbyhq\.com)/i.test(String(url || ""));
}

function normalizeUrl(url) {
  return String(url || "").replace(/[?&]gh_jid=\d+/, "").replace(/\/$/, "");
}

async function readSeen(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    return { urls: Array.isArray(parsed.urls) ? parsed.urls : [] };
  } catch {
    return { urls: [] };
  }
}

function slug(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "job";
}

function parseArgs(items) {
  const out = {};
  for (let i = 0; i < items.length; i++) {
    if (items[i].startsWith("--")) out[items[i].slice(2)] = items[i + 1]?.startsWith("--") ? true : items[++i];
  }
  return out;
}
