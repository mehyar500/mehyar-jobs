import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const queuePath = path.resolve(root, args.queue || "private/queues/application-queue.json");
const maxSubmissions = Math.max(1, Number(args["max-submissions"] || 1));
const queue = JSON.parse(await fs.readFile(queuePath, "utf8"));
if (!Array.isArray(queue.items)) throw new Error("Queue must contain an items array.");

let submitted = 0;
for (const item of queue.items) {
  if (submitted >= maxSubmissions) break;
  if (item.status !== "pending") continue;
  item.started_at = new Date().toISOString();
  const result = await run(item);
  item.updated_at = new Date().toISOString();
  item.audit = result.audit || item.audit || null;
  if (result.outcome === "submitted") { item.status = "submitted"; submitted++; }
  else if (result.outcome === "needs_user_action") item.status = "needs_user_action";
  else item.status = "failed";
  item.last_error = result.error || null;
  await fs.writeFile(queuePath, JSON.stringify(queue, null, 2) + "\n");
}
console.log(JSON.stringify({ submitted, queue: path.relative(root, queuePath), items: queue.items.map(({ id, status, last_error }) => ({ id, status, last_error })) }, null, 2));

function run(item) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/local-application-worker.mjs", "--job-url", item.job_url, "--material", item.material, "--mode", "submit", "--confirm", "APPLY"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", () => {
      const match = output.match(/\{[\s\S]*\}\s*$/);
      let data = {};
      try { data = match ? JSON.parse(match[0]) : {}; } catch {}
      resolve({ outcome: data.outcome || "failed", audit: data.audit, error: data.error || (data.outcome ? null : output.trim().slice(-500)) });
    });
  });
}
function parseArgs(items) { const out = {}; for (let i = 0; i < items.length; i++) if (items[i].startsWith("--")) out[items[i].slice(2)] = items[i + 1]?.startsWith("--") ? true : items[++i]; return out; }
