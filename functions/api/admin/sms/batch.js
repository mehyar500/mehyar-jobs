// Admin: warm-up SMS batch planner + sender.
//
// POST /api/admin/sms/batch { week: 1-4, kind: "repermission"|"alert"|"promo", live?: bool, limit?: n }
//
// - repermission: the ONLY entry gate. Pending contacts with no consent
//   record get the fixed re-permission ask — at most once each, no links
//   before consent, reply DEALS/YES to earn a logged YES.
// - alert/promo: only contacts with a logged YES in sms_consent.
// Volume math is driven by the confirmed-YES cohort (reported in the
// response), never raw list size. US-only default (+1 numbers only).
// DRY-RUN BY DEFAULT: rows are recorded with status 'dry_run' and
// nothing touches Twilio unless { live: true } AND SMS_LIVE=1.
// Consent gate enforced per recipient by sendSms().

import { json, onRequestOptions, requireAdmin } from "../../../_shared/adminAuth.js";
import { ensureSchema } from "../../../_shared/db.js";
import { planWarmupBatch, sendSms, mintLink, warmupCap, REPERMISSION_TEXT } from "../../../_shared/sms.js";
import { APP_URL } from "../../../_shared/seo.js";

export { onRequestOptions as onRequest };

const KINDS = new Set(["repermission", "alert", "promo"]);

export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message || "unauthorized" }, auth.status || 401, request, env);
  await ensureSchema(env).catch(() => null);
  const db = env?.JOBS_DB;
  let b = {};
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400, request, env); }

  const week = Math.max(1, Math.min(4, Number(b.week) || 1));
  const kind = KINDS.has(b.kind) ? b.kind : "alert";
  const live = b.live === true;
  const plan = await planWarmupBatch(db, { week, kind, now: new Date() });
  const limit = Math.min(Number(b.limit) || plan.planned, plan.planned);
  const chosen = plan.contacts.slice(0, limit);

  const results = [];
  let estCostCents = 0;
  for (const c of chosen) {
    let body;
    if (kind === "repermission") {
      // Fixed ask, no links — consent must precede any link.
      body = REPERMISSION_TEXT;
    } else {
      // Mint the subscriber's personal offer-page link; tap is logged on /r/.
      const pageId = await mintLink(db, { contactId: c.contactId, kind: "offer_page", targetUrl: `${APP_URL}/o/__PENDING__` });
      const pageUrl = `${APP_URL}/o/${pageId}`;
      await db.prepare("UPDATE sms_link SET target_url = ? WHERE public_id = ?").bind(pageUrl, pageId).run().catch(() => {});
      const tapId = await mintLink(db, { contactId: c.contactId, kind: "redirect", targetUrl: pageUrl });
      body = kind === "promo"
        ? `mehyar.jobs: your top match this week is live — plus a career boost picked for you: ${APP_URL}/r/${tapId} Reply STOP to end.`
        : `mehyar.jobs: your #1 job match just posted 🎯 ${APP_URL}/r/${tapId} Reply STOP to end.`;
    }
    const r = await sendSms(env, { to: c.phone, body, kind, contactId: c.contactId, live });
    estCostCents += r.costCents || 0;
    results.push({ phone: c.phone.slice(0, 6) + "…", segment: c.segment, ok: r.ok, live: !!r.live, dryRun: !!r.dryRun, error: r.error || null, segments: r.segments || 0 });
  }

  return json({
    ok: true,
    week, kind, cap: warmupCap(week),
    cohort: plan.cohort,
    eligible: plan.eligible, planned: plan.planned, sent: results.length,
    est_cost_cents: estCostCents,
    live: live && String(env?.SMS_LIVE || "") === "1",
    note: kind === "repermission"
      ? "Re-permission ask: one per pending contact, no links. A DEALS/YES reply logs the YES that unlocks alerts/promos."
      : "Dry-run default: no real SMS leaves Twilio unless live:true AND SMS_LIVE=1. Only logged-YES contacts are sent.",
    results,
  }, 200, request, env);
}
