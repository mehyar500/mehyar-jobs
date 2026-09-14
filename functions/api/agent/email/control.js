// Agent control plane for the email growth engine.
//
// POST /api/agent/email/control
// Authorization: Bearer <AGENT_API_TOKEN>
//
// This is the chat control plane. The dashboard Jobs tab is reporting-only;
// campaign control (status, readiness/arm, send, pause) is driven from
// conversation with Mayor. The bearer token is a dedicated secret stored in
// the agent's vault — it is NOT the admin session secret and cannot mint
// dashboard sessions.
//
// Actions (JSON body { action, ...params }):
//   status     -> sender state, fib gate, today's brain plan, today's sends,
//                 seed test, cohort counts. Read-only.
//   readiness  -> run readiness checks; arm sender iff all green. Never sends.
//   send       -> queue the daily sends (live). Requires sender armed and
//                 EMAIL_LIVE=1. Body: { kind?: "warmup"|"repermission"|
//                 "digest"|"promo" }. Refuses when the fib gate is paused.
//   pause      -> set fib_gate status to 'paused' (halts future sends).

import { ensureSchema } from "../../../_shared/db.js";
import { runReadinessChecks, armSender } from "../../../_shared/readinessChecks.js";
import { queueDailySends } from "../../../_shared/emailFunnel.js";
import { signUnsubscribeToken } from "../../../_shared/userAuth.js";
import { buildCampaignReport } from "../../../_shared/campaignReport.js";
import { getSystemFlag } from "../../../_shared/productCatalog.js";

// Constant-time compare for the bearer token.
function safeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function authed(request, env) {
  const expected = env?.AGENT_API_TOKEN || "";
  if (!expected) return false;
  const h = request.headers.get("authorization") || "";
  if (!h.toLowerCase().startsWith("bearer ")) return false;
  return safeEq(h.slice(7).trim(), expected);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function dayStr(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

async function actionStatus(db, env) {
  const today = dayStr();
  const [armedFlag, gate, planRow, seedRow, cohortRows, pendingCount] = await Promise.all([
    getSystemFlag(db, "sender_armed").catch(() => null),
    db.prepare("SELECT level, status, updated_at FROM fib_gate WHERE id = 1").first().catch(() => null),
    db.prepare("SELECT plan_json, reasoning_text, created_at, model FROM campaign_plan WHERE plan_date = ?").bind(today).first().catch(() => null),
    db.prepare("SELECT template, inbox_pct, spam_pct, tested_at FROM seed_test ORDER BY id DESC LIMIT 1").first().catch(() => null),
    db.prepare("SELECT brand, source, status, COUNT(*) AS n FROM email_contact GROUP BY brand, source, status").all().then((r) => r.results || []).catch(() => []),
    db.prepare("SELECT COUNT(*) AS n FROM email_contact WHERE status = 'pending'").first().then((r) => r?.n || 0).catch(() => 0),
  ]);

  let plan = null;
  if (planRow?.plan_json) {
    try {
      const p = JSON.parse(planRow.plan_json);
      plan = { created_at: planRow.created_at, model: planRow.model, weights: p.weights || p.template_weights || null, note: (planRow.reasoning_text || p.note || p.summary || "").slice(0, 280) };
    } catch { plan = { created_at: planRow.created_at, note: "unparseable" }; }
  }

  const report = await buildCampaignReport(db, today, {}).catch(() => null);

  // Per-brand rollup from the brand-segmented cohort rows.
  const byBrand = {};
  for (const r of cohortRows) {
    const b = (byBrand[r.brand] ||= { brand: r.brand, total: 0, by_status: {} });
    b.by_status[r.status] = (b.by_status[r.status] || 0) + r.n;
    b.total += r.n;
  }

  return {
    ok: true,
    date: today,
    live: env.EMAIL_LIVE === "1",
    armed: !!armedFlag,
    armed_at: armedFlag || null,
    fib_gate: gate ? { level: gate.level, status: gate.status, updated_at: gate.updated_at } : null,
    plan,
    seed_test: seedRow || null,
    cohort: { pending: pendingCount, by_source_status: cohortRows, by_brand: byBrand },
    today: report ? {
      sends: report.summary?.sends ?? 0,
      by_status: report.summary?.sends_by_status || {},
      by_brand: report.summary?.by_brand || {},
      opens: report.summary?.opens ?? 0,
      clicks: report.summary?.clicks ?? 0,
      bounces: (report.summary?.hard_bounces ?? 0) + (report.summary?.soft_bounces ?? 0),
      complaints: report.summary?.complaints ?? 0,
      unsubscribes: report.summary?.unsubscribes ?? 0,
    } : null,
  };
}

async function actionReadiness(db, env) {
  const { checks, armed } = await runReadinessChecks(db, env);
  let armedAt = null;
  if (armed) armedAt = await armSender(db);
  return { ok: true, armed, armed_at: armedAt, checks };
}

async function actionSend(db, env, body) {
  const kind = ["warmup", "repermission", "digest", "promo"].includes(body.kind) ? body.kind : "warmup";

  // Hard guards: armed, live, gate not paused.
  const armedFlag = await getSystemFlag(db, "sender_armed").catch(() => null);
  if (!armedFlag) return { ok: false, error: "sender_not_armed", hint: "run the readiness action first" };
  if (env.EMAIL_LIVE !== "1") return { ok: false, error: "not_live", hint: "EMAIL_LIVE is not 1" };
  const gate = await db.prepare("SELECT status FROM fib_gate WHERE id = 1").first().catch(() => null);
  if (gate?.status === "paused") return { ok: false, error: "gate_paused", hint: "fib gate is paused; unpause via dashboard or resume action" };

  const res = await queueDailySends(db, env, {
    live: true, kind, now: new Date(), appUrl: "https://jobs.mehyar.us",
    brand: String(body.brand || "mehyar.jobs").trim().toLowerCase(),
    signUnsub: (email, e, brand) => signUnsubscribeToken(email, e, brand),
  });
  return { ok: res.ok, kind, live: true, ...res };
}

async function actionPause(db) {
  await db.prepare("UPDATE fib_gate SET status = 'paused', updated_at = datetime('now') WHERE id = 1").run().catch(() => null);
  return { ok: true, paused: true };
}

export async function onRequest({ request, env }) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "https://jobs.mehyar.us",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
      },
    });
  }
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (!authed(request, env)) return json({ ok: false, error: "unauthorized" }, 401);

  await ensureSchema(env).catch(() => null);
  const db = env?.JOBS_DB;
  if (!db) return json({ ok: false, error: "db_unconfigured" }, 500);

  let body = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }
  const action = body.action;

  try {
    if (action === "status") return json(await actionStatus(db, env));
    if (action === "readiness") return json(await actionReadiness(db, env));
    if (action === "send") {
      const r = await actionSend(db, env, body);
      return json(r, r.ok ? 200 : 409);
    }
    if (action === "pause") return json(await actionPause(db));
    return json({ ok: false, error: "unknown_action", actions: ["status", "readiness", "send", "pause"] }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
}
