// scripts/test-sms-funnel.mjs
// Warm-up SMS funnel tests (D1 shim):
//   1. Migration 0014 applies; offer_slot seeded with empty cta_url.
//   2. Phone normalization + GSM/UCS-2 segment counting + cost.
//   3. Quiet hours enforcement.
//   4. Consent gate: no message without consent log; dry-run records row.
//   5. Inbound keywords: STOP / DEALS / YES / HELP.
//   6. Tap tracking: /r/ logs tap, marks tapper, 302s.
//   7. Warm-up batch: caps per week, tappers first, quiet-hours skip.
//   8. Offer page: renders #1 match + Sponsored slots + coming-soon; 404 on bad token.
//   9. Email double opt-in + recruiter lead (consent required).
//  10. Admin offer-slots + consent-logged import.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureSchema } from "../functions/_shared/db.js";
import {
  normalizePhoneE164, countSegments, estimateCostCents, isQuietHours,
  warmupCap, canMessage, logConsent, logConsentYes, hasLoggedYes,
  getConsentCohortStats, getFeaturedOfferSlot, offerForTouchpoint, TOUCHPOINT_OFFER,
  offerEmailHtml, offerEmailText,
  sendSms, mintLink, recordTap,
  parseInboundKeyword, planWarmupBatch, getOfferSlots, pickOfferSlots,
  REPERMISSION_TEXT,
} from "../functions/_shared/sms.js";
import { onRequestPost as inboundPost } from "../functions/api/sms/inbound.js";
import { onRequestGet as redirectGet } from "../functions/r/[id].js";
import { onRequestGet as offerPage } from "../functions/o/[token].js";
import { onRequestPost as offerEmailPost } from "../functions/api/public/offer-email.js";
import { onRequestGet as offerEmailConfirm } from "../functions/api/public/offer-email-confirm.js";
import { onRequestPost as recruiterLeadPost } from "../functions/api/public/recruiter-lead.js";
import { onRequestGet as slotsGet, onRequestPut as slotsPut } from "../functions/api/admin/offer-slots.js";
import { onRequestPost as batchPost } from "../functions/api/admin/sms/batch.js";
import { onRequestPost as importPost } from "../functions/api/admin/sms/import.js";
import { onRequestGet as goPage } from "../functions/go/[slug].js";

class D1Shim {
  constructor() { this.db = new DatabaseSync(":memory:"); }
  prepare(sql) {
    const stmt = this.db.prepare(sql);
    const wrap = (params) => ({
      first: async () => stmt.get(...params) ?? null,
      all: async () => ({ results: stmt.all(...params) }),
      run: async () => {
        const r = stmt.run(...params);
        return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
      },
    });
    return { bind: (...p) => wrap(p), first: () => wrap([]).first(), all: () => wrap([]).all(), run: () => wrap([]).run() };
  }
  async batch(list) { const out = []; for (const s of list) out.push(await s.run()); return out; }
}

function b64url(o) {
  return Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
}
async function adminToken(env) {
  const payload = b64url({ sub: "admin", exp: Math.floor(Date.now() / 1000) + 3600 });
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.MESC_JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))).toString("base64url");
  return `${payload}.${sig}`;
}

const twilioCalls = [];
const env = {
  JOBS_DB: new D1Shim(),
  MESC_JWT_SECRET: "test-secret",
  JOBS_APP_URL: "https://jobs.mehyar.us",
  NOTIFY_EMAIL: "owner@example.com",
  EMAIL: { send: async () => ({ id: "m1" }) },
};
globalThis.fetch = async (url, opts) => {
  if (String(url).includes("api.twilio.com")) {
    twilioCalls.push({ url, body: opts?.body });
    return { ok: true, json: async () => ({ sid: "SMxxxx" }) };
  }
  return { ok: true, json: async () => ({ ok: true }) };
};

await ensureSchema(env);
const db = env.JOBS_DB;
const ADMIN = await adminToken(env);
const adminReq = (method, path, body) => new Request(`https://x${path}`, {
  method, headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
  body: body ? JSON.stringify(body) : undefined,
});
const formReq = (path, fields) => new Request(`https://x${path}`, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});
const readJson = async (res) => JSON.parse(await res.text());

// ── 1. migration 0014 ──────────────────────────────────────────────
{
  for (const t of ["sms_contact", "sms_send", "sms_link", "sms_tap", "offer_slot", "recruiter_lead", "newsletter_subscriber", "sms_consent"]) {
    const r = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(t).first();
    assert.ok(r, `table ${t} exists`);
  }
  const slots = await db.prepare("SELECT key, cta_url FROM offer_slot").all();
  assert.equal(slots.results.length, 10, "10 product offer slots seeded");
  assert.ok(slots.results.every((s) => !s.cta_url), "all cta_url empty (AFFILIATE-LINK-NEEDED)");
  console.log("1. migration 0014 ok");
}

// seed a company + job for the offer page
const compR = await db.prepare("INSERT INTO company (name, slug, source, industry) VALUES (?, ?, 'fortune_500', 'Technology')").bind("Acme Corp", "acme-corp").run();
const compId = compR.meta.last_row_id;
await db.prepare(`INSERT INTO job (company_id, external_id, source_kind, url, title, location, remote_policy, employment_type, salary_min, salary_max, posted_at, description_text)
  VALUES (?, 'e1', 'html', 'https://acme.example/j1', 'Senior Backend Engineer', 'New York, NY', 'hybrid', 'full_time', 140000, 180000, '2026-09-10', 'Python AWS Postgres backend role')`).bind(compId).run();

// ── 2. phone + segments ────────────────────────────────────────────
{
  assert.equal(normalizePhoneE164("(212) 555-1234"), "+12125551234");
  assert.equal(normalizePhoneE164("+1 212-555-1234"), "+12125551234");
  assert.equal(normalizePhoneE164("555"), null);
  assert.equal(countSegments("a".repeat(160)), 1);
  assert.equal(countSegments("a".repeat(161)), 2);
  assert.equal(countSegments("héllo ☃"), 1); // UCS-2 single
  assert.equal(countSegments("☃".repeat(71)), 2);
  assert.equal(estimateCostCents(2), 3); // 2 × 1.25c rounds to 3
  console.log("2. phone + segments ok");
}

// ── 3. quiet hours (ET = -300) ─────────────────────────────────────
{
  const at = (h) => new Date(Date.UTC(2026, 8, 14, h + 4, 0, 0)); // h ET -> UTC (EDT=-4)
  assert.equal(isQuietHours(at(7), -240), true);
  assert.equal(isQuietHours(at(12), -240), false);
  assert.equal(isQuietHours(at(21), -240), true);
  assert.equal(isQuietHours(at(8), -240), false);
  console.log("3. quiet hours ok");
}

// ── 4. consent gate + dry-run ──────────────────────────────────────
{
  assert.equal(await canMessage(db, "+12125551234"), false, "unknown number blocked");
  const bad = await sendSms(env, { to: "+12125551234", body: "hi", kind: "alert" });
  assert.equal(bad.ok, false); assert.equal(bad.error, "no_consent");

  // Old-style consent-log mirror alone is NOT enough — no YES row, no send.
  await logConsent(db, "+12125551234", { language: "web form opt-in", source: "test" });
  assert.equal(await canMessage(db, "+12125551234"), false, "pending status still blocked");
  await db.prepare("UPDATE sms_contact SET status='active', tz_offset_min=-240 WHERE phone_e164=?").bind("+12125551234").run();
  assert.equal(await canMessage(db, "+12125551234"), false, "active without a logged YES still blocked");
  const stillBad = await sendSms(env, { to: "+12125551234", body: "hi", kind: "alert" });
  assert.equal(stillBad.error, "no_consent");

  // The ONLY activation path: a logged YES in sms_consent.
  const cid = (await db.prepare("SELECT id FROM sms_contact WHERE phone_e164 = ?").bind("+12125551234").first()).id;
  await logConsentYes(db, cid, "+12125551234", { consentText: "Reply DEALS — test", sourceCohort: "test", replyText: "DEALS" });
  assert.equal(await canMessage(db, "+12125551234"), true);

  const dry = await sendSms(env, { to: "+12125551234", body: "Your #1 match: Senior Backend Engineer https://x", kind: "alert" });
  assert.ok(dry.ok && dry.dryRun && !dry.live, "dry-run default");
  assert.equal(twilioCalls.length, 0, "no Twilio call in dry-run");
  const row = await db.prepare("SELECT status, segments, cost_cents FROM sms_send ORDER BY id DESC LIMIT 1").first();
  assert.equal(row.status, "dry_run");
  assert.ok(row.cost_cents > 0, "cost accumulated");
  console.log("4. consent gate + dry-run ok");
}

// ── 5. inbound keywords ────────────────────────────────────────────
{
  await logConsent(db, "+12125559999", { language: "prior opt-in", source: "test" });
  await db.prepare("UPDATE sms_contact SET status='active', deals_opt_in=0 WHERE phone_e164=?").bind("+12125559999").run();

  let res = await inboundPost({ request: formReq("/api/sms/inbound", { From: "+12125559999", Body: "DEALS" }), env });
  let xml = await res.text();
  assert.ok(xml.includes("You're in"), "DEALS confirms");
  let c = await db.prepare("SELECT deals_opt_in, status, consent_log_json FROM sms_contact WHERE phone_e164=?").bind("+12125559999").first();
  assert.equal(c.deals_opt_in, 1);
  assert.ok(JSON.parse(c.consent_log_json).length >= 2, "consent logged");

  res = await inboundPost({ request: formReq("/api/sms/inbound", { From: "+12125559999", Body: "STOP" }), env });
  xml = await res.text();
  assert.ok(xml.includes("unsubscribed"), "STOP opts out");
  c = await db.prepare("SELECT status FROM sms_contact WHERE phone_e164=?").bind("+12125559999").first();
  assert.equal(c.status, "opted_out");
  assert.equal(await canMessage(db, "+12125559999"), false, "opted-out blocked");

  res = await inboundPost({ request: formReq("/api/sms/inbound", { From: "+12125558888", Body: "YES" }), env });
  assert.ok((await res.text()).includes("Welcome"), "YES confirms pending");
  assert.equal(parseInboundKeyword("help"), "help");
  assert.equal(parseInboundKeyword("stopall"), "stop");
  assert.equal(parseInboundKeyword("hello"), "other");
  console.log("5. inbound keywords ok");
}

// ── 6. tap tracking + redirect ─────────────────────────────────────
{
  await logConsent(db, "+12125557777", { language: "prior opt-in", source: "test" });
  await db.prepare("UPDATE sms_contact SET status='active' WHERE phone_e164=?").bind("+12125557777").run();
  const cc = await db.prepare("SELECT id FROM sms_contact WHERE phone_e164=?").bind("+12125557777").first();
  const pid = await mintLink(db, { contactId: cc.id, kind: "redirect", targetUrl: "https://example.com/offer" });
  const res = await redirectGet({ env, params: { id: pid }, request: new Request("https://x/r/" + pid) });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "https://example.com/offer");
  const seg = await db.prepare("SELECT segment FROM sms_contact WHERE id=?").bind(cc.id).first();
  assert.equal(seg.segment, "tapper", "tapper segment set");
  const bad = await redirectGet({ env, params: { id: "nope" }, request: new Request("https://x/r/nope") });
  assert.equal(bad.status, 404);
  console.log("6. tap tracking ok");
}

// ── 7. warm-up batch planning ──────────────────────────────────────
{
  assert.equal(warmupCap(1), 300); assert.equal(warmupCap(4), 3000); assert.equal(warmupCap(9), 3000);
  // one more active contact, sent already today -> skipped
  const r = await batchPost({ request: adminReq("POST", "/api/admin/sms/batch", { week: 1, kind: "alert", limit: 10 }), env });
  const d = await readJson(r);
  assert.ok(d.ok); assert.equal(d.cap, 300);
  assert.ok(d.planned <= 300);
  assert.ok(d.results.every((x) => x.dryRun), "all dry-run");
  assert.equal(twilioCalls.length, 0, "batch never hits Twilio in dry-run");
  const unauthorized = await batchPost({ request: new Request("https://x/api/admin/sms/batch", { method: "POST", body: "{}" }), env });
  assert.equal(unauthorized.status, 401);
  console.log("7. warm-up batch ok");
}

// ── 8. offer page ──────────────────────────────────────────────────
{
  const cc = await db.prepare("SELECT id FROM sms_contact WHERE phone_e164='+12125557777'").first();
  const { mintLink: ml } = await import("../functions/_shared/sms.js");
  const token = await ml(db, { contactId: cc.id, kind: "offer_page", targetUrl: "https://jobs.mehyar.us/o/PLACEHOLDER" });
  await db.prepare("UPDATE sms_link SET target_url=? WHERE public_id=?").bind(`https://jobs.mehyar.us/o/${token}`, token).run();
  const res = await offerPage({ env, params: { token }, request: new Request("https://jobs.mehyar.us/o/" + token) });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("Senior Backend Engineer"), "renders #1 match");
  assert.ok(html.includes("SPONSORED"), "offers labeled Sponsored");
  assert.ok(html.includes("coming soon"), "empty cta_url renders coming-soon");
  assert.ok(html.includes("Get matched with recruiters"), "recruiter CTA present");
  assert.ok(html.includes('name="email"'), "email capture present");
  const nf = await offerPage({ env, params: { token: "bad" }, request: new Request("https://x/o/bad") });
  assert.equal(nf.status, 404);
  console.log("8. offer page ok");
}

// ── 9. email double opt-in + recruiter lead ────────────────────────
{
  const r = await offerEmailPost({ request: new Request("https://x/api/public/offer-email", { method: "POST", body: JSON.stringify({ email: "sub@example.com", source: "offer_page" }) }), env });
  const d = await readJson(r);
  assert.ok(d.ok);
  let s = await db.prepare("SELECT status, confirm_token FROM newsletter_subscriber WHERE email=?").bind("sub@example.com").first();
  assert.equal(s.status, "pending");
  const c = await offerEmailConfirm({ env, request: new Request(`https://x/api/public/offer-email-confirm?token=${s.confirm_token}`) });
  assert.equal(c.status, 200);
  s = await db.prepare("SELECT status FROM newsletter_subscriber WHERE email=?").bind("sub@example.com").first();
  assert.equal(s.status, "confirmed");

  const noConsent = await recruiterLeadPost({ request: new Request("https://x/api/public/recruiter-lead", { method: "POST", body: JSON.stringify({ name: "X" }) }), env });
  assert.equal((await readJson(noConsent)).error, "consent_required");
  const yes = await recruiterLeadPost({ request: new Request("https://x/api/public/recruiter-lead", { method: "POST", body: JSON.stringify({ name: "Jane", email: "jane@example.com", title: "Engineer", skills: ["Python"], consent: true }) }), env });
  const yd = await readJson(yes);
  assert.ok(yd.ok && yd.lead_id);
  const lead = await db.prepare("SELECT consent_text, status FROM recruiter_lead WHERE id=?").bind(yd.lead_id).first();
  assert.equal(lead.status, "new");
  assert.ok(lead.consent_text.includes("withdraw"), "exact consent language stored");
  console.log("9. email opt-in + recruiter lead ok");
}

// ── 10. admin offer-slots + import ─────────────────────────────────
{
  const g = await slotsGet({ request: adminReq("GET", "/api/admin/offer-slots"), env });
  const gd = await readJson(g);
  assert.ok(gd.ok);
  assert.deepEqual(gd.missing_links.sort(), ["great-resumes-fast", "myperfectresume", "designlab", "coursera", "udemy", "skillshare", "flexjobs", "jobtestprep", "amazon-gear", "sponsor-sms"].sort());
  const p = await slotsPut({ request: adminReq("PUT", "/api/admin/offer-slots", { key: "myperfectresume", cta_url: "https://aff.example/resume?tag=x" }), env });
  assert.ok((await readJson(p)).ok);
  const g2 = await readJson(await slotsGet({ request: adminReq("GET", "/api/admin/offer-slots"), env }));
  assert.ok(!g2.missing_links.includes("myperfectresume"));

  const imp = await importPost({ request: adminReq("POST", "/api/admin/sms/import", { contacts: [
    { phone: "2125550001", consent_language: "web form 2026", consent_source: "import:test" },
    { phone: "bad", consent_language: "x", consent_source: "y" },
    { phone: "2125550002", consent_source: "y" }, // missing language -> rejected
  ] }), env });
  const id = await readJson(imp);
  assert.equal(id.imported, 1); assert.equal(id.rejected_count, 2);
  // Imported rows stay pending: no YES logged → not messageable.
  const st = await db.prepare("SELECT status FROM sms_contact WHERE phone_e164 = '+12125550001'").first();
  assert.equal(st.status, "pending");
  assert.equal(await canMessage(db, "+12125550001"), false, "imported without YES cannot be messaged");
  console.log("10. admin offer-slots + import ok");
}

// ── 11. offer personalization ──────────────────────────────────────
{
  const slots = await getOfferSlots(db);
  const low = pickOfferSlots(slots, { resume_score: 40, skill_gaps: [], remote_ok: false });
  assert.ok(low.some((s) => s.key === "myperfectresume"), "low resume score -> resume slot");
  const rem = pickOfferSlots(slots, { resume_score: 90, skill_gaps: [], remote_ok: true });
  assert.ok(rem.some((s) => s.key === "flexjobs"), "remote pref -> flexjobs slot");
  const gaps = pickOfferSlots(slots, { resume_score: 90, skill_gaps: ["AWS"], remote_ok: false });
  assert.ok(gaps.some((s) => s.key === "coursera"), "skill gaps -> coursera slot");
  assert.ok(REPERMISSION_TEXT.includes("DEALS"), "re-permission template mentions DEALS");
  console.log("11. offer personalization ok");
}

// 12. Compliance: consent table is the only gate; import stays pending;
//     re-permission is one-shot; US-only; cohort math off the YES table.
{
  // Broker-style import with claimed consent language: still pending, never active.
  const r = await importPost({ request: adminReq("POST", "/api/admin/sms/import", { contacts: [
    { phone: "2125550147", consent_language: "claimed prior opt-in", consent_source: "broker_list" },
  ] }), env });
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.status, "pending — re-permission text is the only activation path");
  const c = await db.prepare("SELECT id, status, deals_opt_in FROM sms_contact WHERE phone_e164 = '+12125550147'").first();
  assert.equal(c.status, "pending");
  assert.equal(c.deals_opt_in, 0);
  const yes = await db.prepare("SELECT kind FROM sms_consent WHERE contact_id = ?").bind(c.id).all();
  assert.ok(yes.results.every((x) => x.kind === "import_record"), "import must not log a YES");

  // No YES → alert and promo both refused, even in dry-run.
  const noAlert = await sendSms(env, { to: "+12125550147", body: "test", kind: "alert" });
  assert.equal(noAlert.ok, false); assert.equal(noAlert.error, "no_consent");
  const noPromo = await sendSms(env, { to: "+12125550147", body: "test", kind: "promo" });
  assert.equal(noPromo.ok, false); assert.equal(noPromo.error, "no_consent");
  assert.equal(await canMessage(db, "+12125550147"), false);

  // Re-permission ask allowed once to a pending contact…
  const ask1 = await sendSms(env, { to: "+12125550147", body: REPERMISSION_TEXT, kind: "repermission" });
  assert.equal(ask1.ok, true); assert.equal(ask1.dryRun, true);
  // …never twice.
  const ask2 = await sendSms(env, { to: "+12125550147", body: REPERMISSION_TEXT, kind: "repermission" });
  assert.equal(ask2.ok, false); assert.equal(ask2.error, "repermission_already_sent");

  // Inbound DEALS logs the YES with the reply text → contact becomes messageable.
  const resp = await inboundPost({ request: new Request("https://x/api/sms/inbound", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ From: "+12125550147", Body: "DEALS" }).toString(),
  }), env });
  assert.equal(resp.status, 200);
  const row = await db.prepare("SELECT kind, double_optin_reply, source_cohort FROM sms_consent WHERE contact_id = ? AND kind = 'repermission_yes'").bind(c.id).first();
  assert.equal(row.double_optin_reply, "DEALS");
  assert.equal(row.source_cohort, "inbound");
  assert.equal(await hasLoggedYes(db, c.id), true);
  assert.equal(await canMessage(db, "+12125550147"), true);
  const yesAlert = await sendSms(env, { to: "+12125550147", body: "test", kind: "alert" });
  assert.equal(yesAlert.ok, true);

  // US-only: non-+1 numbers are rejected at normalization.
  assert.equal(normalizePhoneE164("+447700900077"), null);
  const intl = await sendSms(env, { to: "+447700900077", body: "test", kind: "alert" });
  assert.equal(intl.ok, false); assert.equal(intl.error, "bad_phone");

  // Cohort stats driven by the consent table.
  const stats = await getConsentCohortStats(db);
  assert.ok(stats.confirmedYes >= 1, "consent table drives the cohort");
  assert.ok(stats.pending >= 1, "unconsented imports sit in pending");

  // Warm-up plan: promo cohort is the confirmed-YES segment.
  const plan = await planWarmupBatch(db, { week: 1, kind: "promo" });
  assert.equal(plan.cohort.confirmedYes, stats.confirmedYes, "plan volume math uses the YES cohort");
  assert.ok(plan.contacts.some((x) => x.contactId === c.id));

  // Re-permission plan picks only pending contacts with no consent record.
  await importPost({ request: adminReq("POST", "/api/admin/sms/import", { contacts: [
    { phone: "2125550199", consent_language: "claimed prior opt-in", consent_source: "broker_list" },
  ] }), env });
  const rplan = await planWarmupBatch(db, { week: 1, kind: "repermission" });
  assert.ok(rplan.contacts.some((x) => x.phone === "+12125550199"), "pending contact in repermission cohort");
  assert.ok(!rplan.contacts.some((x) => x.phone === "+12125550147"), "consented contact excluded from repermission");
  console.log("12. consent-gate compliance ok");
}

// 13. /go/ product landing pages + placement map.
{
  await db.prepare("UPDATE offer_slot SET cta_url = ''").run(); // pristine: all links AFFILIATE-LINK-NEEDED
  const readHtml = async (res) => ({ status: res.status, html: await res.text() });
  const r = await goPage({ request: new Request("https://x/go/myperfectresume"), env, params: { slug: "myperfectresume" } });
  const { status, html } = await readHtml(r);
  assert.equal(status, 200);
  assert.ok(html.includes("SPONSORED"), "sponsored label present");
  assert.ok(html.includes("Coming soon"), "no affiliate link yet -> coming soon");
  assert.ok(html.includes("My verdict"), "review-style verdict");
  assert.ok(html.includes("1200x628"), "creative spec placeholder");
  assert.ok(html.includes("noindex"), "affiliate pages stay out of the index");
  assert.ok(!html.includes("aff.example"), "no raw affiliate URL anywhere");

  const bad = await goPage({ request: new Request("https://x/go/nope"), env, params: { slug: "nope" } });
  assert.equal(bad.status, 404);

  // With a live affiliate link, CTA becomes a tap-tracked /r/ redirect.
  await db.prepare("UPDATE offer_slot SET cta_url = 'https://aff.example/flex?tag=x' WHERE key = 'flexjobs'").run();
  const r2 = await readHtml(await goPage({ request: new Request("https://x/go/flexjobs"), env, params: { slug: "flexjobs" } }));
  assert.equal(r2.status, 200);
  assert.ok(r2.html.includes("/r/t"), "CTA goes through tap-tracked /r/ link");
  assert.ok(!r2.html.includes("https://aff.example/flex"), "raw affiliate URL never rendered");
  await db.prepare("UPDATE offer_slot SET cta_url = '' WHERE key = 'flexjobs'").run();

  // Placement map: exactly one offer per touchpoint.
  const slots = await getOfferSlots(db);
  assert.equal(offerForTouchpoint("resume_review", slots)?.key, "myperfectresume");
  assert.equal(offerForTouchpoint("skill_gaps", slots)?.key, "coursera");
  assert.equal(offerForTouchpoint("matches_remote", slots)?.key, "flexjobs");
  assert.equal(offerForTouchpoint("advertise", slots), null, "advertise stays employer-side");
  assert.equal(offerForTouchpoint("sms", slots), null, "SMS carries hook + deep link only");

  // Featured offer for the single email affiliate block: none configured -> null -> no block.
  assert.equal(getFeaturedOfferSlot(slots), null);
  assert.equal(offerEmailHtml(null, "https://jobs.mehyar.us"), "");
  assert.deepEqual(offerEmailText(null, "https://jobs.mehyar.us"), []);
  await db.prepare("UPDATE offer_slot SET cta_url = 'https://aff.example/c?tag=x' WHERE key = 'coursera'").run();
  const slots2 = await getOfferSlots(db);
  const feat = getFeaturedOfferSlot(slots2);
  assert.equal(feat.key, "coursera");
  const h = offerEmailHtml(feat, "https://jobs.mehyar.us");
  assert.ok(h.includes("SPONSORED") && h.includes("/go/coursera"), "email block links to landing page, not raw affiliate");
  assert.ok(!h.includes("aff.example"), "no raw affiliate URL in email either");
  await db.prepare("UPDATE offer_slot SET cta_url = '' WHERE key = 'coursera'").run();
  console.log("13. /go/ landing pages + placement map ok");
}

console.log("\nAll SMS funnel tests passed ✅");
process.exit(0);
