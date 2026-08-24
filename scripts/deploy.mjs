// scripts/deploy.mjs
//
// Runs the release gate, applies D1 migrations, then deploys both the SPA
// (including Pages Functions) and the scheduled scanner/email Worker.
// Wrangler uploads root-level functions/ when this command runs from
// the project root, so only the static asset directory is passed here.

import { execSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(".");
const STATIC_DIR = resolve("dist/public");
const deployEnv = { ...process.env };
if (deployEnv.CLOUDFLARE_API_KEY) {
  deployEnv.CLOUDFLARE_EMAIL ||= "mrswelim@gmail.com";
  delete deployEnv.CLOUDFLARE_API_TOKEN;
  delete deployEnv.CF_API_TOKEN;
}

run("npm run check");
run("npm run test:pipeline");
run("npm run test:scanner");
run("npm run test:digest");
run("npm run test:local-worker");
run("npm run build");
// This production D1 predates Wrangler's d1_migrations ledger. Historical
// migrations are already present, so apply the new idempotent migration file
// directly instead of replaying 0001-0006 against live columns.
run("npx wrangler d1 execute mehyar-jobs --remote --config scanner-worker/wrangler.toml --file migrations/0007_daily_job_digest.sql", { CI: "true" });
run(`npx wrangler pages deploy "${STATIC_DIR}" --project-name=mehyar-jobs --branch=main --commit-dirty=true`);
run("npx wrangler deploy --config scanner-worker/wrangler.toml");

function run(command, extraEnv = {}) {
  console.log(`== ${command} ==`);
  execSync(command, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...deployEnv, ...extraEnv },
  });
}
