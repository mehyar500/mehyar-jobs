// scanner-worker/src/campaignBrain.js
//
// The campaign brain: the LLM planner in the middle of the Genius Flow
// email engine ("Mayor Jobs").
//
// Runs once daily at 06:30 ET (two UTC cron entries cover EDT/EST; the
// plan_date PK + the existence check below make it idempotent). It reads
// yesterday's performance (provider stats + D1 aggregates + fib gate +
// product engagement), asks Workers AI for today's plan (template mix,
// product-of-day override, subject tweaks, segment focus, reasoning),
// validates the output server-side, and writes ONE row to campaign_plan.
//
// HARD RULES (standing order):
//   - This module NEVER sends email. It has no send path and imports no
//     send functions.
//   - This module NEVER reads, sets, or references the live-send switch —
//     there is deliberately no code path that can touch it.
//     (grep-asserted by scripts/test-campaign-brain.mjs.)
//   - Stats are never invented: the LLM only sees numbers from the
//     queries below, and the prompt forbids inventing any.

import { ensureSchema } from "../../functions/_shared/db.js";
import { buildCampaignReport } from "../../functions/_shared/campaignReport.js";
import { getActiveProducts } from "../../functions/_shared/productCatalog.js";
import {
  validatePlan,
  resolveProductForPlan,
  SKELETON_IDS,
  SKELETON_NAMES,
  SEGMENT_FOCI,
} from "../../functions/_shared/campaignPlan.js";

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";
const PLAN_MODEL_LABEL = MODEL;

/** Current date in America/New_York as YYYY-MM-DD. */
export function etDate(d = new Date()) {
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/**
 * True once the ET wall-clock reaches 06:25 — the earliest the brain may
 * write today's plan. The 10:30 UTC cron lands at 05:30 ET during EST and
 * must stay dormant; the 11:30 UTC cron is the 06:30 ET one then. During
 * EDT the 10:30 UTC cron is the 06:30 ET one. runCampaignBrain stays
 * idempotent, so a late-firing cron can never double-plan.
 */
export function brainWindowOpen(now = new Date()) {
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return et.getHours() * 60 + et.getMinutes() >= 6 * 60 + 25;
}

/** Add n days to a YYYY-MM-DD string (UTC-noon arithmetic avoids DST edges). */
export function addDays(ymd, n) {
  return new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

/**
 * Yesterday's SMTP2GO email_history, server-side. Returns null when the
 * key is missing or the provider call fails — the brain plans on D1
 * data alone and notes the gap instead of inventing numbers.
 */
async function smtp2goYesterdayStats(env, yesterdayEt) {
  const key = env.SMTP2GO_API_KEY || "";
  if (!key) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch("https://api.smtp2go.com/v3/stats/email_history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        api_key: key,
        start_date: `${yesterdayEt} 00:00:00`,
        end_date: `${yesterdayEt} 23:59:59`,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return null;
    const d = j?.data ?? {};
    return {
      sends: d.count ?? 0,
      bounce_pct: d.bounce_percent_total ?? null,
      complaint_pct: d.spam_percent_total ?? null,
      unsub_pct: d.unsubscribe_percent_total ?? null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Product engagement over the last 30 days from email_event product tags. */
async function productEngagement30d(db) {
  const rows = await db.prepare(
    `SELECT json_extract(meta_json, '$.product') AS slug,
            COUNT(*) AS events,
            SUM(CASE WHEN kind = 'click' THEN 1 ELSE 0 END) AS clicks,
            SUM(CASE WHEN kind = 'open' THEN 1 ELSE 0 END) AS opens,
            MAX(date(created_at)) AS last_seen
     FROM email_event
     WHERE created_at >= date('now', '-30 days')
       AND json_extract(meta_json, '$.product') IS NOT NULL
     GROUP BY slug ORDER BY clicks DESC`
  ).all().then((r) => r.results || []).catch(() => []);
  return rows;
}

/** List sizes + suppression breakdown. */
async function listSizes(db) {
  const rows = await db.prepare(
    "SELECT status, COUNT(*) AS n FROM email_contact GROUP BY status"
  ).all().then((r) => r.results || []).catch(() => []);
  const bands = await db.prepare(
    "SELECT engagement_band, COUNT(*) AS n FROM contact_engagement GROUP BY engagement_band"
  ).all().then((r) => r.results || []).catch(() => []);
  return { statuses: rows, bands };
}

/**
 * Gather everything the LLM may reason about. Every number comes from a
 * query below — nothing is invented.
 */
async function gatherInputs(db, env, yesterday, today) {
  const [provider, report, sizes, products, prodEng] = await Promise.all([
    smtp2goYesterdayStats(env, yesterday),
    buildCampaignReport(db, yesterday).catch(() => null),
    listSizes(db),
    getActiveProducts(db).catch(() => []),
    productEngagement30d(db),
  ]);
  return {
    plan_date: today,
    yesterday,
    provider_yesterday: provider, // null = unavailable, say so in reasoning
    d1_yesterday: report ? report.summary : null,
    fib_gate: report ? report.gate : null,
    sender_armed_at: report ? report.sender_armed_at : null,
    list: sizes,
    // Only eligible products are shown; the LLM must pick from these slugs or null.
    eligible_products: products.map((p) => ({
      slug: p.slug, name: p.name, category: p.category,
      cooldown_days: p.cooldown_days, last_featured_on: p.last_featured_on,
    })),
    product_engagement_30d: prodEng,
  };
}

function skeletonDoc() {
  return SKELETON_IDS.map((id) => `${id} = ${SKELETON_NAMES[id]}`).join(", ");
}

function buildPrompt(inputs) {
  return `You are the campaign planner for a job-seeker newsletter ("mehyar.jobs", daily job matches + one affiliate product woven in with #ad disclosure).

INPUTS (all real numbers from our database and provider — use ONLY these, never invent statistics):
${JSON.stringify(inputs, null, 1)}

DECIDE today's plan and output STRICT JSON only — no prose, no markdown fences, exactly this shape:
{
  "skeleton_weights": {"0": 0.15, "1": 0.35, "2": 0.10, "3": 0.10, "4": 0.15, "5": 0.15},
  "product_override_slug": "some-slug-from-eligible_products" or null,
  "subject_tweaks": [{"skeleton_id": 1, "subject": "one new subject line"}],
  "segment_focus": "engaged_first" | "balanced" | "repermission_heavy" | "winback_heavy",
  "reasoning": "2-4 plain-English sentences explaining the choices, citing the input numbers"
}

RULES:
- Skeletons: ${skeletonDoc()}. skeleton_weights keys must be exactly "0".."5", each a non-negative number, and the six must sum to 1.0.
- Weight the digest (1) highest on normal days; shift weight to winback (2)/repermission (3) when the at_risk/stale bands dominate; value-only (4) earns replies which train inbox placement — keep it nonzero.
- tool-spotlight (5) promotes our own FREE tools (ATS Mirror resume scanner, Resume Studio, AI resume review, job alerts) — never an affiliate product. It is the launch vehicle: weight it high (0.20+) when the list is mostly fresh/pending or when we have a new tool to announce, because "we built this free thing for you" is the strongest repermission hook we have. NOTE: the send path forces legacy/pending contacts onto repermission(3)/tool-spotlight(5) regardless of these weights — so during the launch phase, a high weight on 3 and 5 is honest and safe.
- product_override_slug: pick a slug from eligible_products, or null for the deterministic rotation. Prefer products with low recent clicks (they deserve another shot) but respect that last_featured_on + cooldown_days is enforced server-side — a violating pick is rejected and replaced by the rotation, so do not re-pick a product inside its cooldown window.
- subject_tweaks: 0-4 new subject lines for any skeletons. Each must match its skeleton, contain no "!" and no word "free" (any case), max 120 chars. Never invent a recipient name. Skeleton 5 subjects must match the tool-spotlight voice (a free tool we built, not a product pitch).
  SUBJECT QUALITY IS AN INBOXING WEAPON. Bad subjects ("New job opportunities", "Repermission reminder", "Your daily job match") read as spam to both humans and filters. Every subject must sound like a real person typed it on their phone: specific, concrete, curious — reference the actual tool, a real number from the inputs, or a concrete question. Examples of the bar: "I built a tool that reads resumes like a robot", "One resume per role type beats one for everything". Never use spam-trigger phrasing: "opportunities", "reminder", "alert", "don't miss", "act now", "limited time".
- segment_focus: "engaged_first" when opens/clicks are healthy; "winback_heavy" when at_risk is large; "repermission_heavy" when the list is mostly fresh/pending; "balanced" otherwise.
- reasoning: 2-4 sentences, plain English, citing the actual input numbers. If provider_yesterday is null, say provider stats were unavailable.
- Output JSON only. No commentary.`;
}

/** Extract the first {...} JSON object from model text (tolerates fences/prose). */
export function extractJson(text) {
  const s = String(text || "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no_json_object");
  return JSON.parse(s.slice(start, end + 1));
}

async function planWithLlm(env, inputs) {
  if (!env.AI || typeof env.AI.run !== "function") throw new Error("ai_unavailable");
  const out = await env.AI.run(MODEL, { prompt: buildPrompt(inputs), max_tokens: 1200 });
  const text = typeof out === "string" ? out : out?.response || "";
  const plan = extractJson(text);
  const v = validatePlan(plan);
  if (!v.ok) throw new Error(`plan_invalid: ${v.errors.join("; ")}`);
  return plan;
}

/** Deterministic plan used when the LLM is unavailable or invalid. Always valid.
 *  Launch-leaning: while the list is mostly fresh/pending, repermission (3)
 *  and tool-spotlight (5) carry the mix — the send path forces legacy
 *  contacts onto 3/5 anyway, so this fallback stays honest in both phases. */
export function deterministicFallbackPlan() {
  return {
    skeleton_weights: { 0: 0.1, 1: 0.3, 2: 0.1, 3: 0.2, 4: 0.1, 5: 0.2 },
    product_override_slug: null,
    subject_tweaks: [],
    segment_focus: "balanced",
    reasoning:
      "The LLM planner was unavailable or returned invalid JSON, so the deterministic fallback is in effect: " +
      "a digest-heavy template mix, the catalog rotation product, and balanced segment ordering. " +
      "Yesterday's numbers were left for the dashboard; no stats were invented for this plan.",
  };
}

/**
 * Run the brain for today (ET). Idempotent: if a plan row already exists
 * for today, it returns immediately without calling the LLM.
 */
export async function runCampaignBrain(env) {
  await ensureSchema(env);
  const db = env.JOBS_DB;
  const today = etDate();

  const existing = await db.prepare("SELECT plan_date FROM campaign_plan WHERE plan_date = ?")
    .bind(today).first().catch(() => null);
  if (existing) {
    console.log(JSON.stringify({ event: "campaign_brain_skip", plan_date: today, reason: "already_planned" }));
    return { ok: true, skipped: true, plan_date: today };
  }

  const yesterday = addDays(today, -1);
  const inputs = await gatherInputs(db, env, yesterday, today);

  let plan;
  let modelUsed = PLAN_MODEL_LABEL;
  try {
    plan = await planWithLlm(env, inputs);
  } catch (e) {
    console.error(JSON.stringify({ event: "campaign_brain_llm_failed", plan_date: today, error: String(e?.message || e).slice(0, 200) }));
    plan = deterministicFallbackPlan();
    modelUsed = `${PLAN_MODEL_LABEL}:deterministic-fallback`;
  }

  // Server-side product override enforcement: a violating LLM pick is
  // rejected and replaced by the deterministic rotation.
  const resolved = await resolveProductForPlan(db, today, plan.product_override_slug);
  if (resolved.rejected) {
    console.log(JSON.stringify({ event: "campaign_brain_override_rejected", plan_date: today, slug: plan.product_override_slug, reason: resolved.rejected }));
  }

  const stored = {
    ...plan,
    product_slug: resolved.product ? resolved.product.slug : null,
    product_source: resolved.source,
    product_rejected: resolved.rejected,
  };
  const v = validatePlan(stored);
  if (!v.ok) throw new Error(`stored plan failed validation: ${v.errors.join("; ")}`);

  await db.prepare(
    `INSERT OR REPLACE INTO campaign_plan (plan_date, plan_json, reasoning_text, model, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`
  ).bind(today, JSON.stringify(stored), String(plan.reasoning), modelUsed).run();

  console.log(JSON.stringify({
    event: "campaign_brain_planned", plan_date: today, model: modelUsed,
    product_slug: stored.product_slug, product_source: stored.product_source,
    segment_focus: plan.segment_focus,
  }));
  return {
    ok: true, plan_date: today, model: modelUsed,
    product_slug: stored.product_slug, product_source: stored.product_source,
    fallback: modelUsed !== PLAN_MODEL_LABEL,
  };
}
