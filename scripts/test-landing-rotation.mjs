// scripts/test-landing-rotation.mjs
// Landing rotation tests (D1 shim, Worker 6):
//   1. Migration 0022 applies: landing_slug, landing_hit, contact_preference,
//      email_consent tables exist.
//   2. pref: tokens — sign/verify round-trip; tampered signature rejected;
//      expired token rejected; wrong-format rejected.
//   3. GET /pref/<token> renders the preference form (industries, work style,
//      wants, unchecked consent box); bad token -> 400.
//   4. POST /pref/<token>: preferences persist; contact graduates
//      (status active, source web -> Brevo stream via espForContact);
//      consent checkbox checked -> email_consent row + consent_log_json YES
//      entry; unchecked -> no consent row, still graduated.
//   5. Dated slugs: getOrCreateDaySlug is idempotent (one row per date);
//      /go/<date>-<token> renders the campaign view with the day's product
//      context; clicks log landing_hit + bump counters + email_event click
//      with landing_slug meta; repeat visitor bumps clicks not uniques.
//      Unknown dated slug -> 404.
//   6. Old /go/<offer-slug> review pages still resolve (legacy path intact).
//   7. /gear/<slug>: active+approved product renders with a tap-tracked
//      /r/ CTA, #ad disclosure, and NO raw amazon.com/dp URL in the HTML;
//      unapproved (yotru) renders "not available yet" with NO affiliate
//      link; unknown slug -> 404.
//   8. buildWeaveForSend: weave.url points at /gear/<slug>, never at
//      amazon.com/dp; renderForSkeleton output carries the gear link.
//   9. recordEmailEvent copies go_slug from the latest send meta (open
//      attribution against the day slug).
//  10. Admin landing-stats: 401 without a token; 200 with one; per-page
//      aggregates { slug, page_type, product_slug, clicks, unique_clicks,
//      created_at } for the day.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ensureSchema } from "../functions/_shared/db.js";
import { signPrefToken, verifyPrefToken } from "../functions/_shared/userAuth.js";
import {
  getOrCreateDaySlug, getDaySlug, recordLandingClick, landingStatsForDate,
  ensureEmailContact, getContactPreference, graduateContact, visitorKeyFor,
} from "../functions/_shared/landing.js";
import { buildWeaveForSend, renderForSkeleton, SKELETON, espForContact, recordEmailEvent } from "../functions/_shared/emailFunnel.js";
import { onRequestGet as prefGet, onRequestPost as prefPost } from "../functions/pref/[token].js";
import { onRequestGet as gearGet } from "../functions/gear/[slug].js";
import { onRequestGet as goGet } from "../functions/go/[slug].js";
import { onRequestGet as statsGet } from "../functions/api/admin/email/landing-stats.js";

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

const SECRET = "test-secret-1234567890abcdef";
const env = { JOBS_DB: new D1Shim(), MESC_JWT_SECRET: SECRET, JOBS_APP_URL: "https://jobs.mehyar.us" };
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

await ensureSchema(env);
const db = env.JOBS_DB;

// ── 1. migration 0022 ──────────────────────────────────────────────
{
  for (const t of ["landing_slug", "landing_hit", "contact_preference", "email_consent"]) {
    const r = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(t).first();
    assert.ok(r, `table ${t} exists`);
  }
  console.log("1. migration 0022 tables present");
}

// ── 2. pref: tokens ────────────────────────────────────────────────
const EMAIL = "pref-tester@example.com";
const token = await signPrefToken(EMAIL, env);
{
  assert.equal(await verifyPrefToken(token, env), EMAIL, "round-trip verifies");
  const [p, s] = token.split(".");
  const tampered = `${p.slice(0, -2)}xx.${s}`;
  assert.equal(await verifyPrefToken(tampered, env), null, "tampered payload rejected");
  assert.equal(await verifyPrefToken(`${p}.deadbeef`, env), null, "tampered signature rejected");
  assert.equal(await verifyPrefToken("not-a-token", env), null, "malformed rejected");
  assert.equal(await verifyPrefToken("", env), null, "empty rejected");
  const expired = await signPrefToken(EMAIL, env, -60);
  assert.equal(await verifyPrefToken(expired, env), null, "expired rejected");
  console.log("2. pref: token sign/verify/tamper/expiry OK");
}

// ── 3. GET /pref/<token> ───────────────────────────────────────────
{
  const req = new Request(`https://jobs.mehyar.us/pref/${token}`);
  const res = await prefGet({ request: req, env, params: { token } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("Your job-search preferences"), "form headline");
  assert.ok(html.includes('name="industries"'), "industries checkboxes");
  assert.ok(html.includes('name="work_style"'), "work style radios");
  assert.ok(html.includes('name="wants"'), "wants checkboxes");
  assert.ok(html.includes('name="email_consent"'), "consent checkbox present");
  assert.ok(!html.includes('name="email_consent" checked') && !/email_consent"[^>]*checked/.test(html), "consent unchecked by default");
  const bad = await prefGet({ request: new Request("https://jobs.mehyar.us/pref/bogus"), env, params: { token: "bogus" } });
  assert.equal(bad.status, 400, "bad token -> 400");
  console.log("3. GET /pref/<token> renders; bad token 400");
}

// ── 4. POST /pref/<token>: prefs + graduation + consent ────────────
function fakeForm(fields, multi = {}) {
  return {
    get: (k) => (fields[k] !== undefined ? String(fields[k]) : null),
    getAll: (k) => (multi[k] || []).map(String),
  };
}
const LEGACY = "legacy-pref@example.com";
{
  // Legacy pending contact, as imported by the legacy cohort import.
  await db.prepare(
    "INSERT INTO email_contact (email, status, source, consent_log_json) VALUES (?, 'pending', 'legacy', '[]')"
  ).bind(LEGACY).run();

  const tok = await signPrefToken(LEGACY, env);
  const form = fakeForm(
    { work_style: "remote", email_consent: "yes" },
    { industries: ["technology", "healthcare", "bogus_industry"], wants: ["job_alerts", "resume_review"] }
  );
  const req = { headers: { get: () => null }, formData: async () => form };
  const res = await prefPost({ request: req, env, params: { token: tok } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("Saved."), "saved confirmation");

  const prefs = await getContactPreference(db, (await db.prepare("SELECT id FROM email_contact WHERE email=?").bind(LEGACY).first()).id);
  assert.deepEqual(prefs.industries.sort(), ["healthcare", "technology"], "industries persisted (invalid dropped)");
  assert.equal(prefs.work_style, "remote");
  assert.deepEqual(prefs.wants.sort(), ["job_alerts", "resume_review"]);

  const c = await db.prepare("SELECT * FROM email_contact WHERE email=?").bind(LEGACY).first();
  assert.equal(c.status, "active", "graduated: status active");
  assert.equal(c.source, "web", "graduated: off legacy stream");
  assert.equal(espForContact(c), "brevo", "graduated contact routes to Brevo");
  const log = JSON.parse(c.consent_log_json);
  assert.ok(log.some((e) => e.consent === "yes" && e.source === "preference_page"), "consent_log_json YES entry");
  const consent = await db.prepare("SELECT * FROM email_consent WHERE email=?").bind(LEGACY).first();
  assert.ok(consent, "email_consent row recorded");
  assert.ok(consent.consent_text.includes(LEGACY), "consent language names the address");
  assert.equal(consent.kind, "preference_page_yes");

  const hit = await db.prepare("SELECT * FROM landing_hit WHERE page_type='preference'").bind().first();
  assert.ok(hit, "preference submission logged as a landing hit");
  console.log("4a. POST with consent: prefs saved, graduated to Brevo, consent logged");
}
const NOCONSENT = "noconsent-pref@example.com";
{
  await db.prepare("INSERT INTO email_contact (email, status, source, consent_log_json) VALUES (?, 'pending', 'legacy', '[]')").bind(NOCONSENT).run();
  const tok = await signPrefToken(NOCONSENT, env);
  const form = fakeForm({ work_style: "hybrid" }, { industries: ["finance"], wants: [] });
  const req = { headers: { get: () => null }, formData: async () => form };
  const res = await prefPost({ request: req, env, params: { token: tok } });
  assert.equal(res.status, 200);
  const c = await db.prepare("SELECT * FROM email_contact WHERE email=?").bind(NOCONSENT).first();
  assert.equal(c.status, "active", "still graduated");
  assert.equal(c.source, "web");
  const consent = await db.prepare("SELECT * FROM email_consent WHERE email=?").bind(NOCONSENT).first();
  assert.equal(consent, null, "no consent row when checkbox unchecked");
  console.log("4b. POST without consent: graduated, no consent row");
}

// ── 5. dated slugs ─────────────────────────────────────────────────
const DAY = "2026-09-15";
let daySlug;
{
  daySlug = await getOrCreateDaySlug(db, DAY, { template: "rotation", product_slug: "logitech-c920s", product_angle: "the $70 upgrade" });
  assert.ok(/^\d{4}-\d{2}-\d{2}-[a-z0-9]{6,16}$/.test(daySlug.slug), `slug shape: ${daySlug.slug}`);
  const again = await getOrCreateDaySlug(db, DAY, { template: "other" });
  assert.equal(again.slug, daySlug.slug, "idempotent per date");
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM landing_slug WHERE date=?").bind(DAY).first()).n, 1);
  assert.ok(await getDaySlug(db, daySlug.slug), "getDaySlug resolves");
  assert.equal(await getDaySlug(db, "2026-09-15-zzzzzz99"), null, "unknown dated slug -> null");
  assert.equal(await getDaySlug(db, "coursera"), null, "non-dated slug not matched");
  console.log("5a. getOrCreateDaySlug idempotent; shape OK");

  // Campaign view renders with the day's product context.
  const req = new Request(`https://jobs.mehyar.us/go/${daySlug.slug}`);
  const res = await goGet({ request: req, env, params: { slug: daySlug.slug } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("Logitech C920s Webcam"), "product of the day shown");
  assert.ok(html.includes("/gear/logitech-c920s"), "links to the gear page");
  assert.ok(html.includes("#ad"), "disclosure on the campaign view");

  // Unknown dated slug -> 404 from the dated branch.
  const miss = await goGet({ request: new Request("https://jobs.mehyar.us/go/2026-09-15-zzzzzz99"), env, params: { slug: "2026-09-15-zzzzzz99" } });
  assert.equal(miss.status, 404);

  // Attribution: identified click.
  const ctok = await signPrefToken(LEGACY, env);
  const cid = (await db.prepare("SELECT id FROM email_contact WHERE email=?").bind(LEGACY).first()).id;
  const clickReq = new Request(`https://jobs.mehyar.us/go/${daySlug.slug}?c=${ctok}`, { headers: { "cf-connecting-ip": "9.9.9.9" } });
  const clickRes = await goGet({ request: clickReq, env, params: { slug: daySlug.slug } });
  assert.equal(clickRes.status, 200);
  const clickHtml = await clickRes.text();
  assert.ok(clickHtml.includes(`/pref/${ctok}`), "preference CTA keeps the signed token");
  const row = await db.prepare("SELECT * FROM landing_slug WHERE slug=?").bind(daySlug.slug).first();
  assert.equal(row.clicks, 2, "anonymous + identified clicks counted"); // 1 anon view above + this one
  assert.equal(row.unique_clicks, 2, "two distinct visitors");
  // Repeat visitor: clicks up, uniques flat.
  await goGet({ request: clickReq, env, params: { slug: daySlug.slug } });
  const row2 = await db.prepare("SELECT * FROM landing_slug WHERE slug=?").bind(daySlug.slug).first();
  assert.equal(row2.clicks, 3);
  assert.equal(row2.unique_clicks, 2, "repeat visitor not double-counted");
  const ev = await db.prepare(
    "SELECT meta_json FROM email_event WHERE contact_id=? AND kind='click' ORDER BY id DESC LIMIT 1"
  ).bind(cid).first();
  assert.ok(ev, "email_event click logged for identified contact");
  const meta = JSON.parse(ev.meta_json);
  assert.equal(meta.landing_slug, daySlug.slug);
  assert.equal(meta.landing_page, "go");
  assert.equal(meta.product_slug, "logitech-c920s");
  console.log("5b. /go/<date>-<token> resolves, attributes clicks; unknowns 404");
}

// ── 6. old /go/<offer-slug> pages still resolve ────────────────────
{
  await db.prepare(
    `INSERT OR IGNORE INTO offer_slot (key, name, slot_type, headline, body, cta_text, cta_url, priority, is_active)
     VALUES ('coursera', 'Coursera', 'affiliate', 'Close the skill gap', 'Body copy here.', 'Learn more', '', 10, 1)`
  ).run();
  const res = await goGet({ request: new Request("https://jobs.mehyar.us/go/coursera"), env, params: { slug: "coursera" } });
  assert.equal(res.status, 200, "legacy offer slug still resolves");
  const html = await res.text();
  assert.ok(html.includes("Career certificates from Google, Meta"), "legacy review content intact");
  const miss = await goGet({ request: new Request("https://jobs.mehyar.us/go/no-such-offer"), env, params: { slug: "no-such-offer" } });
  assert.equal(miss.status, 404, "unknown legacy slug still 404s");
  console.log("6. legacy /go/<offer-slug> pages unaffected");
}

// ── 7. /gear/ pages ────────────────────────────────────────────────
{
  const res = await gearGet({ request: new Request(`https://jobs.mehyar.us/gear/logitech-c920s?d=${DAY}`), env, params: { slug: "logitech-c920s" } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("Logitech C920s Webcam"), "product name");
  assert.ok(html.includes("1080p webcam with autofocus"), "catalog description");
  assert.ok(html.includes("#ad"), "affiliate disclosure on the page");
  assert.ok(/href="https:\/\/jobs\.mehyar\.us\/r\/[A-Za-z0-9_-]+"/.test(html), "CTA goes through tap-tracked /r/<id>");
  assert.ok(!html.includes("amazon.com/dp"), "raw Amazon URL never in the HTML");
  // The tap link must still reach the real affiliate URL server-side.
  const linkRow = await db.prepare("SELECT target_url FROM sms_link WHERE kind='gear_click' ORDER BY id DESC LIMIT 1").bind().first();
  assert.ok(linkRow.target_url.includes("amazon.com/dp/B07K986YLL?tag=mehyarus-20"), "tap target is the real affiliate URL");

  const yotru = await gearGet({ request: new Request("https://jobs.mehyar.us/gear/yotru"), env, params: { slug: "yotru" } });
  assert.equal(yotru.status, 200, "unapproved product page exists");
  const yhtml = await yotru.text();
  assert.ok(/not available yet/i.test(yhtml), "coming-soon copy");
  assert.ok(!yhtml.includes("/r/"), "no tap link for unapproved");
  assert.ok(!yhtml.includes("yotru.com/affiliate"), "no affiliate URL for unapproved");

  const jtp = await gearGet({ request: new Request("https://jobs.mehyar.us/gear/jobtestprep"), env, params: { slug: "jobtestprep" } });
  assert.equal(jtp.status, 200);
  assert.ok(/not available yet/i.test(await jtp.text()), "jobtestprep also coming-soon");

  const miss = await gearGet({ request: new Request("https://jobs.mehyar.us/gear/nope"), env, params: { slug: "nope" } });
  assert.equal(miss.status, 404);
  console.log("7. /gear/: active renders CTA+#ad; unapproved suppressed; unknown 404");
}

// ── 8. email weave points at /gear/, never Amazon ──────────────────
{
  const { weave } = await buildWeaveForSend(db, DAY, "https://jobs.mehyar.us", null);
  assert.ok(weave, "a weave is built");
  assert.ok(weave.url.startsWith("https://jobs.mehyar.us/gear/"), `weave url: ${weave.url}`);
  assert.ok(!weave.url.includes("amazon.com"), "no Amazon URL in the weave");

  const rendered = renderForSkeleton({
    skeleton: SKELETON.HOOK_LOCAL, weave,
    contact: { email: "w@example.com", first_name: "W" },
    personalization: { matches: [], resumeScore: null, hasResume: false },
    marketData: { city: "Raleigh", postingCount: 42, remotePct: 31, salaryBand: "$80k–$110k" },
    unsubUrl: "https://jobs.mehyar.us/unsubscribe", appUrl: "https://jobs.mehyar.us",
    goSlugUrl: `https://jobs.mehyar.us/go/${daySlug.slug}`,
  });
  assert.ok(rendered.html.includes(`/gear/${weave.slug}`), "rendered email links to the gear page");
  assert.ok(!rendered.html.includes("amazon.com/dp"), "no Amazon URL in rendered email");
  assert.ok(rendered.html.includes("#ad"), "disclosure survives in the email");
  assert.ok(rendered.html.includes(`/go/${daySlug.slug}`), "dated slug linked in the email");
  console.log("8. campaign emails link to /gear/, not Amazon");
}

// ── 9. recordEmailEvent copies go_slug (open attribution) ──────────
{
  const em = "open-attr@example.com";
  await db.prepare("INSERT INTO email_contact (email, status, source) VALUES (?, 'active', 'web')").bind(em).run();
  const cid = (await db.prepare("SELECT id FROM email_contact WHERE email=?").bind(em).first()).id;
  await db.prepare(
    "INSERT INTO email_send (contact_id, kind, template, status, meta_json) VALUES (?, 'warmup', 'daily_digest', 'sent', ?)"
  ).bind(cid, JSON.stringify({ skeleton: "digest", product: "logitech-c920s", go_slug: daySlug.slug })).run();
  const r = await recordEmailEvent(db, em, "open", {});
  assert.equal(r.action, "engaged");
  const ev = await db.prepare("SELECT meta_json FROM email_event WHERE contact_id=? ORDER BY id DESC LIMIT 1").bind(cid).first();
  const meta = JSON.parse(ev.meta_json);
  assert.equal(meta.go_slug, daySlug.slug, "open attributed to the day slug");
  assert.equal(meta.product, "logitech-c920s");
  console.log("9. opens attribute to the day slug via send-meta copy");
}

// ── 10. admin landing-stats ────────────────────────────────────────
function b64u(buf) { return Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"); }
function adminToken(secret, sub = "admin") {
  const p = b64u(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }));
  const sig = b64u(crypto.createHmac("sha256", secret).update(p).digest());
  return `${p}.${sig}`;
}
{
  // Seed hits for the day: go clicks, gear clicks, preference click.
  await recordLandingClick(db, { date: DAY, pageType: "gear", slug: "logitech-c920s", productSlug: "logitech-c920s", contactId: null, ip: "1.1.1.1" });
  await recordLandingClick(db, { date: DAY, pageType: "gear", slug: "logitech-c920s", productSlug: "logitech-c920s", contactId: null, ip: "2.2.2.2" });
  await recordLandingClick(db, { date: DAY, pageType: "gear", slug: "logitech-c920s", productSlug: "logitech-c920s", contactId: null, ip: "1.1.1.1" });
  await recordLandingClick(db, { date: DAY, pageType: "preference", slug: "preference", contactId: null, ip: "5.5.5.5" });
  await recordLandingClick(db, { date: DAY, pageType: "preference", slug: "preference", contactId: null, ip: "5.5.5.5" });

  const noAuth = await statsGet({ request: new Request(`https://x/api/admin/email/landing-stats?date=${DAY}`), env });
  assert.equal(noAuth.status, 401, "no token -> 401");
  const badDate = await statsGet({
    request: new Request("https://x/api/admin/email/landing-stats?date=nope", { headers: { authorization: `Bearer ${adminToken(SECRET)}` } }), env,
  });
  assert.equal(badDate.status, 400, "bad date -> 400");

  const res = await statsGet({
    request: new Request(`https://x/api/admin/email/landing-stats?date=${DAY}`, { headers: { authorization: `Bearer ${adminToken(SECRET)}` } }), env,
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.date, DAY);
  const gear = body.stats.find((s) => s.page_type === "gear" && s.slug === "logitech-c920s");
  assert.ok(gear, "gear row present");
  assert.equal(gear.clicks, 4, "gear clicks aggregate (3 seeded + 1 page view)");
  assert.equal(gear.unique_clicks, 3, "gear uniques dedupe by visitor");
  assert.equal(gear.product_slug, "logitech-c920s");
  const go = body.stats.find((s) => s.page_type === "go" && s.slug === daySlug.slug);
  assert.ok(go, "go row present");
  assert.equal(go.clicks, 3, "go clicks aggregate");
  assert.equal(go.unique_clicks, 2);
  assert.ok(go.created_at, "go row carries created_at");
  const pref = body.stats.find((s) => s.page_type === "preference");
  assert.ok(pref, "preference row present");
  assert.equal(pref.clicks, 2, "preference clicks aggregate");
  assert.equal(pref.unique_clicks, 1, "preference uniques dedupe");
  for (const s of body.stats) {
    assert.ok(s.slug && s.page_type && typeof s.clicks === "number" && typeof s.unique_clicks === "number" && s.created_at, "row shape");
    assert.ok(["preference", "gear", "go"].includes(s.page_type), "page_type vocab");
  }
  console.log("10. landing-stats API: auth + per-page aggregates OK");
}

// visitorKey sanity
assert.equal(visitorKeyFor(7, "1.2.3.4"), "c7");
assert.ok(visitorKeyFor(null, "1.2.3.4").startsWith("h"));
assert.equal(visitorKeyFor(null, "1.2.3.4"), visitorKeyFor(null, "1.2.3.4"), "anonymous key stable");

console.log("\nAll landing-rotation tests passed.");
process.exit(0);
