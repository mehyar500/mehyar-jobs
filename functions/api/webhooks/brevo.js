// POST /api/webhooks/brevo
// Brevo event webhook for the per-brand warmup campaigns.
// Register at https://api.brevo.com/v3/webhooks with URL:
//   https://jobs.mehyar.us/api/webhooks/brevo
// Enable events: opened, click, delivered, hard_bounce, soft_bounce,
// complaint, unsubscribed.
//
// Security: Brevo webhooks carry no HMAC signature. If the Pages env var
// BREVO_WEBHOOK_KEY is set, the request must include ?key=<value>.
// Without the key configured, requests are accepted and logged (note it).
//
// Payload shape (Brevo): { event, email, "message-id", date, tag, ... }
import { ensureSchema } from "../../_shared/db.js";

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  const want = env?.BREVO_WEBHOOK_KEY || "";
  if (want && url.searchParams.get("key") !== want) {
    return new Response(JSON.stringify({ ok: false, error: "bad_key" }), {
      status: 403, headers: { "content-type": "application/json" },
    });
  }

  let body = {};
  try { body = await request.json(); } catch { /* ignore */ }
  // Brevo may batch events as an array.
  const events = Array.isArray(body) ? body : [body];

  if (env?.JOBS_DB) await ensureSchema(env).catch(() => null);
  const db = env?.JOBS_DB;
  if (!db) {
    return new Response(JSON.stringify({ ok: false, error: "no_db" }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }

  const now = new Date().toISOString();
  let handled = 0;
  for (const ev of events) {
    const rawKind = String(ev?.event || "");
    // Brevo uses camelCase (hardBounce); normalize to snake_case.
    const kind = rawKind.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
    const email = String(ev?.email || "").trim().toLowerCase();
    const msgId = String(ev?.["message-id"] || ev?.message_id || "").trim();
    if (!kind || !email) continue;
    try {
      await handleEvent(db, kind, email, msgId, now);
      handled++;
    } catch { /* per-event best effort */ }
  }
  return new Response(JSON.stringify({ ok: true, handled }), {
    headers: { "content-type": "application/json" },
  });
}

async function findSend(db, email, msgId) {
  if (msgId) {
    const r = await db.prepare(
      "SELECT id, brand, campaign_day, recipient_email, status FROM warmup_campaign_sends WHERE message_id = ?"
    ).bind(msgId).first().catch(() => null);
    if (r) return r;
  }
  // Fallback: latest warmup send to this address (any brand).
  return await db.prepare(
    "SELECT id, brand, campaign_day, recipient_email, status FROM warmup_campaign_sends WHERE recipient_email = ? ORDER BY id DESC LIMIT 1"
  ).bind(email).first().catch(() => null);
}

async function refreshDaily(db, brand, day) {
  const agg = await db.prepare(`
    SELECT COUNT(*) AS sent,
      SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened,
      SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked,
      SUM(CASE WHEN status IN ('bounced','hard_bounced') THEN 1 ELSE 0 END) AS bounced,
      SUM(CASE WHEN status = 'unsubscribed' THEN 1 ELSE 0 END) AS unsub
    FROM warmup_campaign_sends WHERE brand = ? AND campaign_day = ?
  `).bind(brand, day).first().catch(() => null);
  if (!agg) return;
  await db.prepare(`
    UPDATE warmup_campaign_daily
    SET sent_count = ?, open_count = ?, click_count = ?, bounce_count = ?, unsub_count = ?
    WHERE brand = ? AND campaign_day = ?
  `).bind(agg.sent || 0, agg.opened || 0, agg.clicked || 0, agg.bounced || 0, agg.unsub || 0, brand, day).run().catch(() => {});
}

async function suppressContact(db, email, brand, status, reason) {
  const row = await db.prepare(
    "SELECT id FROM email_contact WHERE email = ? AND brand = ?"
  ).bind(email, brand).first().catch(() => null);
  if (row) {
    await db.prepare("UPDATE email_contact SET status = ? WHERE id = ?")
      .bind(status, row.id).run().catch(() => {});
    await db.prepare(
      "UPDATE contact_engagement SET suppressed_at = ?, suppress_reason = ?, updated_at = ? WHERE contact_id = ?"
    ).bind(new Date().toISOString(), reason, new Date().toISOString(), row.id).run().catch(() => {});
  }
  await db.prepare("UPDATE newsletter_subscriber SET status = 'unsubscribed' WHERE email = ? AND brand = ?")
    .bind(email, brand).run().catch(() => {});
}

async function handleEvent(db, kind, email, msgId, now) {
  const send = await findSend(db, email, msgId);
  const brand = send?.brand || "mehyar.jobs";

  if (kind === "opened") {
    if (send) {
      await db.prepare("UPDATE warmup_campaign_sends SET opened_at = COALESCE(opened_at, ?), status = CASE WHEN status = 'sent' THEN 'delivered' ELSE status END WHERE id = ?")
        .bind(now, send.id).run().catch(() => {});
      await refreshDaily(db, send.brand, send.campaign_day);
    }
    return;
  }
  if (kind === "click") {
    if (send) {
      await db.prepare("UPDATE warmup_campaign_sends SET clicked_at = COALESCE(clicked_at, ?), opened_at = COALESCE(opened_at, ?) WHERE id = ?")
        .bind(now, now, send.id).run().catch(() => {});
      await refreshDaily(db, send.brand, send.campaign_day);
    }
    return;
  }
  if (kind === "delivered" || kind === "sent") {
    if (send) {
      await db.prepare("UPDATE warmup_campaign_sends SET status = 'delivered' WHERE id = ? AND status = 'sent'")
        .bind(send.id).run().catch(() => {});
    }
    return;
  }
  if (kind === "hard_bounce" || kind === "soft_bounce") {
    if (send) {
      await db.prepare("UPDATE warmup_campaign_sends SET bounced_at = ?, status = 'bounced' WHERE id = ?")
        .bind(now, send.id).run().catch(() => {});
      await refreshDaily(db, send.brand, send.campaign_day);
    }
    if (kind === "hard_bounce") {
      // Hard bounces suppress the central contact so we never mail them again.
      await suppressContact(db, email, brand, "bounced", "hard_bounce");
    }
    return;
  }
  if (kind === "complaint" || kind === "spam") {
    if (send) {
      await db.prepare("UPDATE warmup_campaign_sends SET status = 'complained' WHERE id = ?")
        .bind(send.id).run().catch(() => {});
      await refreshDaily(db, send.brand, send.campaign_day);
    }
    await suppressContact(db, email, brand, "complained", "spam_complaint");
    return;
  }
  if (kind === "unsubscribed") {
    if (send) {
      await db.prepare("UPDATE warmup_campaign_sends SET status = 'unsubscribed' WHERE id = ?")
        .bind(send.id).run().catch(() => {});
      await refreshDaily(db, send.brand, send.campaign_day);
    }
    // Same opt-out the one-click link performs: brand-scoped funnel row.
    await suppressContact(db, email, brand, "opted_out", "brevo_unsubscribed");
    return;
  }
  // Unknown event kinds are ignored (logged by the platform).
}
