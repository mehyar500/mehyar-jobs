// POST /api/sms/inbound — Twilio inbound SMS webhook.
//
// Handles STOP (opt-out), HELP (info), DEALS (marketing re-permission),
// YES/START (confirm pending opt-in). Every keyword action is logged to
// the contact's consent log — the consent record TCPA requires.
// Responds with TwiML. Safe to call in dry-run: inbound processing
// never sends outbound SMS by itself (replies go through Twilio's
// webhook response).

import { ensureSchema } from "../../_shared/db.js";
import { normalizePhoneE164, parseInboundKeyword, logConsent, logConsentYes, twiml, DEALS_CONFIRMED_TEXT, WELCOME_TEXT, HELP_TEXT } from "../../_shared/sms.js";

async function readForm(request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/x-www-form-urlencoded")) {
    const text = await request.text();
    return Object.fromEntries(new URLSearchParams(text));
  }
  try { return await request.json(); } catch { return {}; }
}

export async function onRequestPost({ request, env }) {
  await ensureSchema(env).catch(() => null);
  const db = env?.JOBS_DB;
  const form = await readForm(request);
  const phone = normalizePhoneE164(form.From || form.from);
  const body = String(form.Body || form.body || "");
  if (!phone || !db) {
    return new Response(twiml(""), { headers: { "Content-Type": "text/xml" } });
  }

  const keyword = parseInboundKeyword(body);
  const contact = await db.prepare("SELECT id, status FROM sms_contact WHERE phone_e164 = ?")
    .bind(phone).first().catch(() => null);

  const ensure = async () => {
    if (!contact) {
      await logConsent(db, phone, { language: body.slice(0, 160), source: "inbound_sms" });
    }
  };

  if (keyword === "stop") {
    await ensure();
    await db.prepare("UPDATE sms_contact SET status = 'opted_out', deals_opt_in = 0 WHERE phone_e164 = ?")
      .bind(phone).run().catch(() => {});
    await logConsent(db, phone, { language: "STOP (opt-out)", source: "inbound_sms" });
    return new Response(twiml("You've been unsubscribed from mehyar.jobs SMS. No more texts. Reply START to rejoin."), {
      headers: { "Content-Type": "text/xml" },
    });
  }

  if (keyword === "help") {
    return new Response(twiml(HELP_TEXT), { headers: { "Content-Type": "text/xml" } });
  }

  if (keyword === "deals") {
    await ensure();
    const c = await db.prepare("SELECT id FROM sms_contact WHERE phone_e164 = ?").bind(phone).first().catch(() => null);
    // THE entry gate: this YES row in sms_consent is what makes the
    // number messageable. Reply text is stored verbatim.
    if (c) {
      await logConsentYes(db, c.id, phone, {
        consentText: "Reply DEALS — opted in to weekly career-deals texts (resume help, courses, remote jobs). ~1 msg/day. Reply STOP to end. Msg&data rates may apply.",
        sourceCohort: "inbound",
        replyText: body.trim().toUpperCase().slice(0, 16),
      });
    }
    await logConsent(db, phone, {
      language: "Reply DEALS — opted in to weekly career-deals texts (resume help, courses, remote boards). 1-2 msgs/wk. Reply STOP to end. Msg&data rates may apply.",
      source: "inbound_sms:DEALS",
    });
    return new Response(twiml(DEALS_CONFIRMED_TEXT), { headers: { "Content-Type": "text/xml" } });
  }

  if (keyword === "yes") {
    await ensure();
    const c = await db.prepare("SELECT id FROM sms_contact WHERE phone_e164 = ?").bind(phone).first().catch(() => null);
    if (c) {
      await logConsentYes(db, c.id, phone, {
        consentText: "Reply YES/START — confirmed opt-in to mehyar.jobs job-alert texts. ~1 msg/day. Reply STOP to end. Msg&data rates may apply.",
        sourceCohort: "inbound",
        replyText: body.trim().toUpperCase().slice(0, 16),
        deals: false, // YES confirms job alerts; DEALS is what unlocks promos.
      });
    }
    await logConsent(db, phone, {
      language: "Reply YES/START — confirmed opt-in to mehyar.jobs job-alert texts. ~1 msg/day. Reply STOP to end. Msg&data rates may apply.",
      source: "inbound_sms:YES",
    });
    return new Response(twiml(WELCOME_TEXT), { headers: { "Content-Type": "text/xml" } });
  }

  // Unknown text: gentle nudge, no state change.
  return new Response(twiml("mehyar.jobs: reply DEALS for weekly career deals, HELP for help, STOP to end."), {
    headers: { "Content-Type": "text/xml" },
  });
}
