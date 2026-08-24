// POST /api/admin/cron/scrape?cursor=0&limit=3
//
// Runs a bounded, resumable batch. The previous implementation crawled
// the entire directory in one HTTP request; Pages could terminate that
// request after partial D1 writes, leaving the UI with a failure and no
// completed scrape_run record. Callers continue with next_cursor until
// done=true.

import { requireAdmin, json, onRequestOptions } from "../../../_shared/adminAuth.js";
import { ensureSchema } from "../../../_shared/db.js";
import { scanCompanyBatch, syncContractJobs, syncSeedCompanies } from "../../../_shared/scan.js";

export { onRequestOptions as onRequest };

export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);

  await ensureSchema(env);
  const url = new URL(request.url);
  const body = await request.json().catch(() => ({}));
  const cursor = Math.max(0, Number(body.cursor ?? url.searchParams.get("cursor") ?? 0));
  const limit = Math.max(1, Math.min(10, Number(body.limit ?? url.searchParams.get("limit") ?? 3)));
  const includeContracts = body.include_contracts ?? url.searchParams.get("include_contracts") !== "0";

  let seeded = 0;
  let contracts = null;
  if (cursor === 0) {
    seeded = await syncSeedCompanies(env.JOBS_DB);
    if (includeContracts) contracts = await syncContractJobs(env);
  }

  const batch = await scanCompanyBatch(env, { afterId: cursor, limit, trigger: "manual_batch" });
  return json({ ...batch, seeded, contracts }, 200, request, env);
}

export async function onRequestGet(context) {
  return onRequestPost(context);
}
