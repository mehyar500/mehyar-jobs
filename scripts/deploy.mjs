// scripts/deploy.mjs
//
// Deploys the SPA + Pages Functions to Cloudflare Pages.
// 1. build client → dist/
// 2. copy functions/ → dist/functions/ (Pages auto-discovers)
// 3. wrangler pages deploy dist/

import { execSync } from "node:child_process";
import { mkdirSync, cpSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(".");
const DIST = resolve("dist");

console.log("== npm run build (vite) ==");
execSync("npm run build", { cwd: ROOT, stdio: "inherit" });

console.log("== syncing functions/ → dist/functions/ ==");
mkdirSync(`${DIST}/functions`, { recursive: true });
cpSync(`${ROOT}/functions`, `${DIST}/functions`, { recursive: true });

console.log("== wrangler pages deploy ==");
execSync("npx wrangler pages deploy " + DIST + " --project-name=mehyar-jobs --branch=main --commit-dirty=true", {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env },
});