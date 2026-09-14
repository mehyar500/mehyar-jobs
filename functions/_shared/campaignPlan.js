// _shared/campaignPlan.js
//
// Campaign-plan schema, validation, and sender-side plan resolution for
// the Genius Flow email engine ("Mayor Jobs").
//
// The brain (scanner-worker/src/campaignBrain.js) WRITES one validated
// plan row per day into campaign_plan. The daily sender
// (queueDailySends in emailFunnel.js) READS it via resolvePlanForSend()
// and follows it; with no (or an invalid) row it falls back to the
// existing deterministic behavior.
//
// HARD RULES (standing order):
//   - This module NEVER sends email.
//   - This module NEVER reads, sets, or references the live-send switch.
//     (grep-asserted by scripts/test-campaign-brain.mjs.)
//
// Plan shape (plan_json):
// {
//   "skeleton_weights":   {"0":0.20,"1":0.40,"2":0.10,"3":0.15,"4":0.15},  // sums to ~1.0
//   "product_override_slug": "logitech-c920s" | null,                     // LLM pick, server-validated
//   "subject_tweaks":     [{"skeleton_id":1,"subject":"..."}],            // appended to subject pools
//   "segment_focus":      "engaged_first"|"balanced"|"repermission_heavy"|"winback_heavy",
//   "reasoning":          "2-4 sentence plain-English summary",
//   "product_slug":       "<resolved slug>",        // written by the brain after validation
//   "product_source":     "llm_override"|"deterministic_fallback"|"deterministic_rotation",
//   "product_rejected":   null | "unknown_slug"|"inactive"|"unapproved"|"cooldown"
// }

import { hashStr } from "./emailFunnel.js";
import { getProductBySlug, getProductOfDay } from "./productCatalog.js";

/** Skeleton ids from docs/GENIUS_FLOW.md §1 (skeleton_idx = hash % 6). */
export const SKELETON_IDS = [0, 1, 2, 3, 4, 5];

export const SKELETON_NAMES = {
  0: "hook-local",
  1: "digest",
  2: "winback",
  3: "repermission",
  4: "value-only",
  5: "tool-spotlight",
};

/** Allowed segment_focus values. */
export const SEGMENT_FOCI = ["engaged_first", "balanced", "repermission_heavy", "winback_heavy"];

export const SUBJECT_TWEAK_MAX = 10;
export const SUBJECT_TWEAK_MAX_LEN = 120;

/**
 * Validate a plan object against the schema. Structural only — the
 * product override's catalog/cooldown eligibility is checked separately
 * by validateProductOverride() with a live db handle.
 * @param {any} plan
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validatePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return { ok: false, errors: ["plan must be an object"] };
  }

  // ── skeleton_weights ──
  const w = plan.skeleton_weights;
  if (!w || typeof w !== "object" || Array.isArray(w)) {
    errors.push("skeleton_weights missing or not an object");
  } else {
    for (const id of SKELETON_IDS) {
      if (!(String(id) in w)) errors.push(`skeleton_weights missing id ${id}`);
    }
    for (const k of Object.keys(w)) {
      if (!SKELETON_IDS.includes(Number(k))) errors.push(`skeleton_weights unknown skeleton id '${k}'`);
    }
    let sum = 0;
    let anyPositive = false;
    for (const k of Object.keys(w)) {
      const v = w[k];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        errors.push(`skeleton_weights[${k}] is not a finite number`);
        continue;
      }
      if (v < 0) errors.push(`skeleton_weights[${k}] is negative`);
      if (v > 0) anyPositive = true;
      sum += v;
    }
    if (!anyPositive) errors.push("skeleton_weights are all zero");
    else if (sum < 0.99 || sum > 1.01) errors.push(`skeleton_weights sum ${sum} is not sane (must be ~1.0)`);
  }

  // ── product_override_slug ──
  const slug = plan.product_override_slug;
  if (slug !== null && slug !== undefined) {
    if (typeof slug !== "string" || !slug.trim()) {
      errors.push("product_override_slug must be null or a non-empty string");
    }
  }

  // ── subject_tweaks ──
  const tweaks = plan.subject_tweaks;
  if (tweaks !== null && tweaks !== undefined) {
    if (!Array.isArray(tweaks)) {
      errors.push("subject_tweaks must be an array");
    } else {
      if (tweaks.length > SUBJECT_TWEAK_MAX) errors.push(`subject_tweaks has ${tweaks.length} entries (max ${SUBJECT_TWEAK_MAX})`);
      tweaks.forEach((t, i) => {
        if (!t || typeof t !== "object") { errors.push(`subject_tweaks[${i}] is not an object`); return; }
        if (!SKELETON_IDS.includes(Number(t.skeleton_id))) errors.push(`subject_tweaks[${i}] bad skeleton_id`);
        const sub = String(t.subject ?? "");
        if (sub.length < 3 || sub.length > SUBJECT_TWEAK_MAX_LEN) errors.push(`subject_tweaks[${i}] subject length out of range`);
        // Copy rules (docs/GENIUS_FLOW.md §2): no FREE, no all-caps words, no exclamation marks.
        if (sub.includes("!")) errors.push(`subject_tweaks[${i}] contains '!'`);
        if (/\bfree\b/i.test(sub)) errors.push(`subject_tweaks[${i}] contains 'free'`);
      });
    }
  }

  // ── segment_focus ──
  if (!SEGMENT_FOCI.includes(plan.segment_focus)) {
    errors.push(`segment_focus must be one of ${SEGMENT_FOCI.join(", ")}`);
  }

  // ── reasoning ──
  const reasoning = String(plan.reasoning ?? "");
  if (reasoning.length < 20 || reasoning.length > 2000) {
    errors.push("reasoning must be 20-2000 chars (2-4 plain-English sentences)");
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Server-side eligibility check for the LLM's product override.
 * The override is accepted ONLY when the product is active AND approved
 * AND its per-product cooldown has elapsed since last_featured_on.
 * @param {object} db D1-ish handle
 * @param {string} dateStr YYYY-MM-DD
 * @param {string} slug
 * @returns {Promise<{ ok: boolean, product?: object, reason?: string }>}
 */
export async function validateProductOverride(db, dateStr, slug) {
  if (!slug) return { ok: false, reason: "no_override" };
  const product = await getProductBySlug(db, String(slug)).catch(() => null);
  if (!product) return { ok: false, reason: "unknown_slug" };
  if (product.active !== 1) return { ok: false, reason: "inactive" };
  if (product.approved !== 1) return { ok: false, reason: "unapproved" };
  if (product.last_featured_on) {
    const daysSince = (Date.parse(`${dateStr}T00:00:00Z`) - Date.parse(`${product.last_featured_on}T00:00:00Z`)) / 86400000;
    if (!(daysSince >= Number(product.cooldown_days || 30))) {
      return { ok: false, reason: "cooldown" };
    }
  }
  return { ok: true, product };
}

/**
 * Resolve the day's product: the LLM override when it passes
 * validateProductOverride(), otherwise the deterministic
 * getProductOfDay() rotation. Never returns an ineligible product.
 * @returns {Promise<{ product: object|null, source: string, rejected: string|null }>}
 */
export async function resolveProductForPlan(db, dateStr, overrideSlug) {
  if (overrideSlug) {
    const v = await validateProductOverride(db, dateStr, overrideSlug);
    if (v.ok) return { product: v.product, source: "llm_override", rejected: null };
    const fallback = await getProductOfDay(db, dateStr).catch(() => null);
    return { product: fallback, source: "deterministic_fallback", rejected: v.reason };
  }
  const rotation = await getProductOfDay(db, dateStr).catch(() => null);
  return { product: rotation, source: "deterministic_rotation", rejected: null };
}

/**
 * Read one plan row. Returns null when the table/row is missing or the
 * stored JSON is corrupt — the sender treats that as "no plan".
 */
export async function readPlanRow(db, dateStr) {
  const row = await db.prepare(
    "SELECT plan_date, plan_json, reasoning_text, model, created_at FROM campaign_plan WHERE plan_date = ?"
  ).bind(dateStr).first().catch(() => null);
  if (!row) return null;
  try {
    return { ...row, plan: JSON.parse(row.plan_json) };
  } catch {
    return null;
  }
}

/**
 * Sender-side plan resolution for one send date. Returns null when there
 * is no usable plan (the sender must then use its deterministic fallback).
 * The stored plan_json already passed validation at write time; the
 * product slug is re-fetched so the sender weaves the current row.
 */
export async function resolvePlanForSend(db, dateStr) {
  const row = await readPlanRow(db, dateStr);
  if (!row) return null;
  const v = validatePlan(row.plan);
  if (!v.ok) {
    console.warn(JSON.stringify({ event: "campaign_plan_invalid", plan_date: dateStr, errors: v.errors }));
    return null;
  }
  let product = null;
  const slug = row.plan.product_slug || row.plan.product_override_slug || null;
  if (slug) product = await getProductBySlug(db, String(slug)).catch(() => null);
  return {
    row,
    plan: row.plan,
    product,
    skeletonWeights: row.plan.skeleton_weights,
    subjectTweaks: Array.isArray(row.plan.subject_tweaks) ? row.plan.subject_tweaks : [],
    segmentFocus: row.plan.segment_focus,
  };
}

/**
 * Deterministic per-recipient skeleton pick from the plan's weight mix.
 * Stable per recipient per day via hashStr(email|date), so no recipient
 * sees two versions and the list shows no bot-blast fingerprint.
 * With no plan weights, returns 1 (digest) — the legacy behavior.
 */
export function chooseSkeletonIdx(weights, email, dateStr) {
  if (!weights || typeof weights !== "object") return 1;
  const em = String(email || "").trim().toLowerCase();
  const r = (hashStr(`${em}|${dateStr}`) % 10000) / 10000;
  let acc = 0;
  for (const id of SKELETON_IDS) {
    acc += Number(weights[String(id)] || 0);
    if (r < acc) return id;
  }
  return 1;
}

/**
 * Reorder a send list for the plan's segment focus. Stable: ties keep
 * buildDailyList's order (Gmail-first pacing is preserved within bands).
 */
export function applySegmentFocus(list, focus) {
  if (!Array.isArray(list) || !focus || focus === "balanced") return list;
  const rank = (c) => {
    if (focus === "winback_heavy") return c.variant === "winback" ? 0 : 1;
    if (focus === "repermission_heavy") return c.band === "fresh" || c.band == null ? 0 : 1;
    if (focus === "engaged_first") return c.band === "high" || c.band === "moderate" ? 0 : 1;
    return 0;
  };
  return list
    .map((c, i) => [c, i])
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
    .map(([c]) => c);
}
