import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const baseUrl = (process.env.JOBS_BASE_URL || "https://jobs.mehyar.us").replace(/\/$/, "");
const target = Math.max(1, Math.min(10, Number(args.target || 10)));
const fitMin = Math.max(0, Math.min(100, Number(args["fit-min"] || 70)));
const headless = args.headless !== "false";
let token = process.env.MEHYAR_JOBS_TOKEN || "";

if (!token && process.env.MEHYARSOFT_ADMIN_USERNAME && process.env.MEHYARSOFT_ADMIN_PASSWORD) {
  const response = await fetch(baseUrl + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: process.env.MEHYARSOFT_ADMIN_USERNAME,
      password: process.env.MEHYARSOFT_ADMIN_PASSWORD,
    }),
  });
  const body = await response.json().catch(() => ({}));
  token = body.token || "";
}

if (!token) {
  console.error("Set MEHYAR_JOBS_TOKEN or MEHYARSOFT_ADMIN_USERNAME and MEHYARSOFT_ADMIN_PASSWORD in this local shell.");
  process.exit(1);
}

const statusBefore = await request("/api/admin/pipeline");
const submittedToday = Number(statusBefore.today?.submitted || 0);
const remaining = Math.max(0, target - submittedToday);
if (remaining <= 0) {
  console.log(JSON.stringify({ ok: true, message: "daily_target_already_met", target, submitted_today: submittedToday }, null, 2));
  process.exit(0);
}

await request("/api/admin/cron/score", { method: "POST" });
await request("/api/admin/applications/queue", {
  method: "POST",
  body: JSON.stringify({ fit_min: fitMin, max: remaining, run_now: false }),
});

const queue = await request("/api/admin/applications/queue?status=pending");
const candidates = (queue.items || [])
  .filter((item) => item.application_id && supported(item.job_url))
  .slice(0, remaining);

const skippedUnsupported = (queue.items || [])
  .filter((item) => item.application_id && !supported(item.job_url))
  .slice(0, remaining)
  .map((item) => ({ queue_id: item.id, application_id: item.application_id, job_url: item.job_url, reason: "unsupported_ats" }));

let submitted = 0;
const results = [];
for (const item of candidates) {
  if (submitted >= remaining) break;
  const app = (await request(`/api/admin/applications/${item.application_id}`)).application;
  const materialPath = await writeMaterial(app);
  const result = await runWorker(item.application_id, materialPath);
  if (result.outcome === "submitted") submitted++;
  results.push({
    queue_id: item.id,
    application_id: item.application_id,
    company: item.company_name,
    title: item.job_title,
    fit: item.job_score,
    outcome: result.outcome,
    audit: result.audit,
    error: result.error || null,
  });
}

console.log(JSON.stringify({
  ok: true,
  target,
  submitted_before: submittedToday,
  attempted: results.length,
  submitted,
  remaining_after_run: Math.max(0, target - submittedToday - submitted),
  skipped_unsupported: skippedUnsupported,
  results,
}, null, 2));

async function request(url, init = {}) {
  const response = await fetch(baseUrl + url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${url} ${body.error || body.message || "request_failed"}`);
  return body;
}

async function writeMaterial(app) {
  const dir = path.join(root, "private", "materials", "auto");
  await fs.mkdir(dir, { recursive: true });
  const custom = typeof app.custom_answers === "object" && app.custom_answers ? app.custom_answers : {};
  const material = {
    cover_letter: String(app.cover_letter || "").slice(0, 2200),
    answers: Object.entries(custom)
      .filter(([question, answer]) => question && answer)
      .map(([question, answer]) => ({ question, answer: String(answer).slice(0, 1800) }))
      .slice(0, 20),
    facts_used: [
      app.job_title || "job title",
      app.company_name || "company",
      "remote profile metadata",
      "stored resume",
    ],
    needs_review: [],
  };
  const file = path.join(dir, `app-${app.id}.json`);
  await fs.writeFile(file, JSON.stringify(material, null, 2) + "\n", "utf8");
  return path.relative(root, file);
}

function runWorker(applicationId, materialPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      "scripts/local-application-worker.mjs",
      "--application", String(applicationId),
      "--material", materialPath,
      "--mode", "submit",
      "--confirm", "APPLY",
      "--headless", String(headless),
    ], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, MEHYAR_JOBS_TOKEN: token, JOBS_BASE_URL: baseUrl },
    });
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

function supported(url) {
  return /(greenhouse\.io|ashbyhq\.com)/i.test(String(url || ""));
}

function parseArgs(items) {
  const out = {};
  for (let i = 0; i < items.length; i++) {
    if (items[i].startsWith("--")) out[items[i].slice(2)] = items[i + 1]?.startsWith("--") ? true : items[++i];
  }
  return out;
}
