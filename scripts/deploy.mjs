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
// All mehyar-jobs resources (D1, Pages, Worker) live in this account.
process.env.CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "621600637337cc1c9ecb7095508bc732";
const deployEnv = { ...process.env };
if (deployEnv.CLOUDFLARE_API_KEY) {
  deployEnv.CLOUDFLARE_EMAIL ||= "mrswelim@gmail.com";
  delete deployEnv.CLOUDFLARE_API_TOKEN;
  delete deployEnv.CF_API_TOKEN;
}

const WR = "python3 /home/hatch/workspace/skills/cloudflare/bin/wr.py"; // wrangler with stored CF credential

run("npm run check");
run("npm run test:pipeline");
run("npm run test:scanner");
run("npm run test:digest");
run("npm run test:local-worker");
run("npm run test:multiuser");
run("npm run test:e2e-user");
run("npm run test:user-digests");
run("npm run test:job-alerts");
run("npm run test:email-funnel");
run("npm run build");
// This production D1 predates Wrangler's d1_migrations ledger. Historical
// migrations are already present, so apply the new idempotent migration file
// directly instead of replaying 0001-0006 against live columns.
for (const mig of ["0007_daily_job_digest.sql", "0008_multiuser.sql", "0009_user_digest_log.sql", "0010_llm_review.sql", "0011_anon_free_run.sql", "0012_job_alerts.sql", "0013_growth_engine.sql", "0014_sms_funnel.sql", "0015_product_slots.sql", "0016_consent_table.sql", "0017_email_warmup.sql", "0018_product_catalog.sql", "0019_product_details.sql", "0020_email_send_meta.sql", "0021_campaign_plan.sql", "0022_landing_rotation.sql", "0023_brand.sql"]) {
  try {
    run(`${WR} d1 execute mehyar-jobs --remote --config scanner-worker/wrangler.toml --file migrations/${mig}`, { CI: "true" });
  } catch (err) {
    // Migrations are re-run on every deploy; an already-applied migration
    // (e.g. ADD COLUMN on an existing column) fails harmlessly here.
    console.warn(`migration ${mig} skipped/failed (continuing):`, String(err?.message || err).split("\n")[0]);
  }
}
run(`${WR} pages deploy "${STATIC_DIR}" --project-name=mehyar-jobs --branch=main --commit-dirty=true`);
run(`${WR} deploy --config scanner-worker/wrangler.toml`);

function run(command, extraEnv = {}) {
  console.log(`== ${command} ==`);
  execSync(command, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...deployEnv, ...extraEnv },
  });
}
