// _shared/campaignReport.js
//
// Daily campaign report ("Mayor Jobs" tab data): one day's sends, events,
// subjects, offers, products, landing pages, and gate state — all from D1,
// plain JSON-serializable. The endpoint may merge in provider-side stats
// (SMTP2GO email_history); this builder accepts them via { smtp2goStats }.

import { getGate } from "./emailFunnel.js";
import { getProductOfDay, getSystemFlag, productAngles } from "./productCatalog.js";

/**
 * @typedef {object} DbLike
 * @param {DbLike} db
 * @param {string} dateStr YYYY-MM-DD (UTC)
 * @param {{ smtp2goStats?: object|null }} [opts]
 * @returns {Promise<object>}
 */
export async function buildCampaignReport(db, dateStr, { smtp2goStats = null } = {}) {
  // ── sends by status (a send counts for the day its email went out or
  // was recorded; dry runs count as recorded that day) ──
  const sendRows = await db.prepare(
    `SELECT status, COUNT(*) AS n
     FROM email_send
     WHERE coalesce(date(sent_at), date(created_at)) = ?
     GROUP BY status`
  ).bind(dateStr).all().then((r) => r.results || []).catch(() => []);
  const sendsByStatus = {};
  let sends = 0;
  for (const r of sendRows) {
    sendsByStatus[r.status] = r.n;
    sends += r.n;
  }

  // ── events by kind ──
  const eventRows = await db.prepare(
    `SELECT kind, COUNT(*) AS n
     FROM email_event
     WHERE date(created_at) = ?
     GROUP BY kind`
  ).bind(dateStr).all().then((r) => r.results || []).catch(() => []);
  const eventsByKind = {};
  for (const r of eventRows) eventsByKind[r.kind] = r.n;
  const opens = eventsByKind.open || 0;
  const clicks = eventsByKind.click || 0;
  const hardBounces = eventsByKind.hard_bounce || 0;
  const softBounces = eventsByKind.soft_bounce || 0;
  const complaints = eventsByKind.complaint || 0;
  const unsubscribes = eventsByKind.unsubscribe || 0;
  const delivered = Math.max(sends - hardBounces, 1);
  const ctr = clicks / Math.max(sends, 1);              // clicks per send
  const openRate = opens / Math.max(delivered, 1);      // opens per delivered
  const bounceRate = (hardBounces + softBounces) / Math.max(sends, 1);
  const complaintRate = complaints / Math.max(sends, 1);

  // ── email bodies: template × variant × subject ──
  const emailRows = await db.prepare(
    `SELECT template, variant, subject, COUNT(*) AS sends, COUNT(DISTINCT contact_id) AS recipients
     FROM email_send
     WHERE coalesce(date(sent_at), date(created_at)) = ?
     GROUP BY template, variant, subject
     ORDER BY sends DESC LIMIT 50`
  ).bind(dateStr).all().then((r) => r.results || []).catch(() => []);

  // ── offers: meta_json.offer aggregation ──
  const offerRows = await db.prepare(
    `SELECT json_extract(meta_json, '$.offer') AS offer,
            COUNT(*) AS n,
            SUM(CASE WHEN kind = 'click' THEN 1 ELSE 0 END) AS clicks,
            SUM(CASE WHEN kind = 'open' THEN 1 ELSE 0 END) AS opens
     FROM email_event
     WHERE date(created_at) = ? AND json_extract(meta_json, '$.offer') IS NOT NULL
     GROUP BY offer ORDER BY n DESC`
  ).bind(dateStr).all().then((r) => r.results || []).catch(() => []);

  // ── products: product of the day (no markFeatured — reporting never
  // mutates rotation) + product-tagged events (meta_json.product) ──
  const podRaw = await getProductOfDay(db, dateStr).catch(() => null);
  const productOfDay = podRaw
    ? {
        slug: podRaw.slug, name: podRaw.name, category: podRaw.category,
        url: podRaw.url, angles: productAngles(podRaw),
      }
    : null;
  const productEventRows = await db.prepare(
    `SELECT json_extract(meta_json, '$.product') AS product,
            COUNT(*) AS n,
            SUM(CASE WHEN kind = 'click' THEN 1 ELSE 0 END) AS clicks,
            SUM(CASE WHEN kind = 'open' THEN 1 ELSE 0 END) AS opens
     FROM email_event
     WHERE date(created_at) = ? AND json_extract(meta_json, '$.product') IS NOT NULL
     GROUP BY product ORDER BY n DESC`
  ).bind(dateStr).all().then((r) => r.results || []).catch(() => []);

  // ── landing pages: no per-day landing-page tracking yet ──
  const goSlugs = await db.prepare(
    "SELECT key FROM offer_slot WHERE is_active = 1 ORDER BY priority"
  ).all().then((r) => (r.results || []).map((x) => x.key)).catch(() => []);

  // ── gate + sender-armed flag ──
  const gate = await getGate(db).catch(() => null);
  const armedAt = await getSystemFlag(db, "sender_armed").catch(() => null);

  // ── cohort (for the reporting-only dashboard; replaces wire-up's check) ──
  const cohortRows = await db.prepare(
    "SELECT status, COUNT(*) AS n FROM email_contact GROUP BY status"
  ).all().then((r) => r.results || []).catch(() => []);
  const cohortByStatus = {};
  let cohortTotal = 0;
  for (const r of cohortRows) { cohortByStatus[r.status] = r.n; cohortTotal += r.n; }

  // ── per-brand breakdown: subscribers by brand/status, sends+events by brand ──
  const brandCohortRows = await db.prepare(
    "SELECT brand, status, COUNT(*) AS n FROM email_contact GROUP BY brand, status"
  ).all().then((r) => r.results || []).catch(() => []);
  const brandSendRows = await db.prepare(
    `SELECT brand, status, COUNT(*) AS n FROM email_send
     WHERE coalesce(date(sent_at), date(created_at)) = ?
     GROUP BY brand, status`
  ).bind(dateStr).all().then((r) => r.results || []).catch(() => []);
  const brandEventRows = await db.prepare(
    `SELECT brand, kind, COUNT(*) AS n FROM email_event
     WHERE date(created_at) = ?
     GROUP BY brand, kind`
  ).bind(dateStr).all().then((r) => r.results || []).catch(() => []);
  const byBrand = {};
  const brandOf = (b) => (byBrand[b] ||= { brand: b, subscribers: {}, sends: 0, sends_by_status: {}, opens: 0, clicks: 0, bounces: 0, complaints: 0, unsubscribes: 0 });
  for (const r of brandCohortRows) brandOf(r.brand).subscribers[r.status] = r.n;
  for (const r of brandSendRows) { const b = brandOf(r.brand); b.sends_by_status[r.status] = r.n; b.sends += r.n; }
  for (const r of brandEventRows) {
    const b = brandOf(r.brand);
    if (r.kind === "open") b.opens = r.n;
    else if (r.kind === "click") b.clicks = r.n;
    else if (r.kind === "hard_bounce" || r.kind === "soft_bounce") b.bounces += r.n;
    else if (r.kind === "complaint") b.complaints = r.n;
    else if (r.kind === "unsubscribe") b.unsubscribes = r.n;
  }

  return {
    ok: true,
    date: dateStr,
    summary: {
      sends,
      sends_by_status: sendsByStatus,
      opens, clicks, hard_bounces: hardBounces, soft_bounces: softBounces,
      complaints, unsubscribes,
      delivered_estimate: sends - hardBounces,
      ctr: round6(ctr),
      open_rate: round6(openRate),
      bounce_rate: round6(bounceRate),
      complaint_rate: round6(complaintRate),
      by_brand: byBrand,
    },
    emails: emailRows,
    offers: offerRows,
    products: {
      product_of_day: productOfDay,
      events: productEventRows,
    },
    landing_pages: {
      created: [],
      note: "preference landing page not yet built — no per-day landing page tracking yet",
      active_go_slugs: goSlugs,
    },
    gate,
    sender_armed_at: armedAt,
    cohort: { total: cohortTotal, by_status: cohortByStatus },
    provider: smtp2goStats || null,
  };
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}
