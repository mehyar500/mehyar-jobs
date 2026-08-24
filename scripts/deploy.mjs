// scripts/deploy.mjs
//
// Deploys the SPA plus Pages Functions to Cloudflare Pages.
// Wrangler uploads root-level functions/ when this command runs from
// the project root, so only the static asset directory is passed here.

import { execSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(".");
const STATIC_DIR = resolve("dist/public");

console.log("== npm run build (vite) ==");
execSync("npm run build", { cwd: ROOT, stdio: "inherit" });

console.log("== wrangler pages deploy ==");
const deployEnv = { ...process.env };
if (deployEnv.CLOUDFLARE_API_KEY) {
  deployEnv.CLOUDFLARE_EMAIL ||= "mrswelim@gmail.com";
  delete deployEnv.CLOUDFLARE_API_TOKEN;
  delete deployEnv.CF_API_TOKEN;
}
execSync(`npx wrangler pages deploy "${STATIC_DIR}" --project-name=mehyar-jobs --branch=main --commit-dirty=true`, {
  cwd: ROOT,
  stdio: "inherit",
  env: deployEnv,
});
