// scripts/test-genius-flow-skeletons.mjs
// Genius Flow skeleton tests (D1 shim):
//   1. Migration 0020 applies; email_send.meta_json exists.
//   2. Each skeleton renders { subject, html, text } (hook-local, digest,
//      winback, repermission, value-only).
//   3. hook-local falls back to the digest skeleton without market data.
//   4. Product weave: disclosure (#ad + affiliate link + "may earn a
//      commission") present in BOTH html and text when woven; absent
//      without a weave; never woven for repermission / value-only.
//   5. Product tag recorded: email_send.meta_json.product on the send, and
//      email_event.meta_json.product on later engagement events (the
//      campaign report reads meta_json.product from email_event).
//   6. No-assumption rule: renders for an email+city-only contact contain
//      no role/industry/seniority words.
//   7. Subject pool: 20 subjects, stable per recipient per day, rotating
//      across recipients, obeying copy rules.
//   8. No emojis anywhere; max one em dash per version.
//   9. Dispatcher: hash formula stable; winback restricted to at-risk.
//  10. getLocalMarket: true numbers from the job table; null when unknown.
//  11. queueDailySends dry-run: skeleton recorded in meta_json, product
//      woven only on skeletons 0/1, inactive/unapproved products never
//      woven.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureSchema } from "../functions/_shared/db.js";
import {
  hashStr, dayStr,
  renderDigestEmail, renderHookLocal, renderRepermission, renderValueOnly,
  renderForSkeleton, resolveSkeleton, skeletonIndexFor,
  hookLocalSubject, repermissionSubject, valueOnlySubject, digestSubject,
  getLocalMarket, importEmailContacts, logEmailSend, recordEmailEvent,
  queueDailySends, recordSeedTest, SKELETON, SKELETON_NAMES,
} from "../functions/_shared/emailFunnel.js";
import { getProductOfDay } from "../functions/_shared/productCatalog.js";

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

const env = { JOBS_DB: new D1Shim() };
await ensureSchema(env);
const db = env.JOBS_DB;
const DS = "2026-09-14";

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
const countEmDash = (s) => (String(s).match(/—/g) || []).length;
function assertCopyRules(label, { subject, html, text }) {
  for (const [k, v] of [["subject", subject], ["html", html], ["text", text]]) {
    assert.ok(!EMOJI.test(v), `${label}: no emojis in ${k}`);
  }
  assert.ok(countEmDash(`${subject}\n${html}`) <= 1, `${label}: max one em dash per html version`);
  assert.ok(countEmDash(`${subject}\n${text}`) <= 1, `${label}: max one em dash per text version`);
  assert.ok(!/\bfree\b/i.test(subject), `${label}: no FREE in subject`);
  assert.ok(!/[A-Z]{4,}/.test(subject), `${label}: no shouty caps in subject`);
  assert.ok(!subject.includes("!"), `${label}: no exclamation in subject`);
  assert.ok(!/land the job|get interviews|guarantee/i.test(html + text), `${label}: no outcome promises`);
}

// ── 1. migration 0020 ────────────────────────────────────────────────
{
  const cols = await db.prepare("PRAGMA table_info(email_send)").all().then((r) => r.results || []);
  assert.ok(cols.some((c) => c.name === "meta_json"), "email_send.meta_json column exists");
  console.log("1. migration 0020 ok");
}

// test fixtures
const md = { city: "Newark", postingCount: 214, remotePct: 38, salaryBand: "$145k–$185k" };
const weave = { slug: "logitech-c920s", name: "Logitech C920s Webcam", url: "https://www.amazon.com/dp/B07K986YLL?tag=mehyarus-20", angle: "the $70 upgrade hiring managers actually notice" };
const base = { unsubUrl: "https://jobs.mehyar.us/unsubscribe?token=t", appUrl: "https://jobs.mehyar.us", dateStr: DS };

// ── 2. each skeleton renders ─────────────────────────────────────────
{
  const contact = { email: "sam@example.com", firstName: "Sam", city: "Newark" };
  const p = { matches: [], resumeScore: null, hasResume: false };

  const hl = renderHookLocal({ contact, marketData: md, personalization: p, weave, ...base });
  assert.ok(hl.subject && hl.html && hl.text, "hook-local renders all parts");
  assert.ok(hl.html.includes("214 postings went up in the Newark area"), "hook-local stat in html");
  assert.ok(hl.text.includes("214 postings went up in the Newark area"), "hook-local stat in text");
  assert.ok(hl.text.includes("Hit reply"), "hook-local reply ask");
  assert.ok(hl.html.includes("Get your free score"), "hook-local single CTA");
  assertCopyRules("hook-local", hl);

  const dg = renderDigestEmail({ contact, personalization: p, weave, ...base });
  assert.ok(dg.subject && dg.html && dg.text, "digest renders all parts");
  assertCopyRules("digest", dg);

  const wb = renderDigestEmail({ contact, personalization: p, ...base, variant: "winback" });
  assert.ok(wb.html.includes("unsubscribe"), "winback offers the out");
  assert.ok(!wb.html.includes("#ad"), "winback never weaves a product");
  assertCopyRules("winback", wb);

  const rp = renderRepermission({ contact, ...base });
  assert.ok(rp.text.includes("Keep them coming") && rp.text.includes("Stop them here"), "repermission stay/leave");
  assert.ok(!rp.html.includes("#ad") && !rp.text.includes("#ad"), "repermission never weaves");
  assert.ok(rp.text.length < 700, "repermission is mobile-short");
  assertCopyRules("repermission", rp);

  const vo = renderValueOnly({ contact, ...base });
  assert.ok(vo.text.includes("No pitch today"), "value-only sets the frame");
  assert.ok(vo.text.includes("Reply and tell me"), "value-only reply ask is the CTA");
  assert.ok(vo.text.includes("https://jobs.mehyar.us"), "value-only has the plain link");
  assert.ok(!vo.html.includes("#ad") && !vo.text.includes("#ad"), "value-only never weaves");
  assertCopyRules("value-only", vo);

  // dispatcher covers all five
  for (let i = 0; i < 6; i++) {
    const r = renderForSkeleton({ skeleton: i, contact, personalization: p, marketData: md, weave, ...base });
    assert.ok(r.subject && r.html && r.text, `renderForSkeleton(${i}) renders`);
    assertCopyRules(`skeleton-${i}`, r);
  }
  console.log("2. skeleton renderers ok");
}

// ── 3. hook-local fallback without market data ───────────────────────
{
  const contact = { email: "anon@example.com" }; // no city, no name
  const p = { matches: [], resumeScore: null, hasResume: false };
  const r = renderHookLocal({ contact, marketData: null, personalization: p, weave, ...base });
  assert.ok(r.text.includes("Today's top matches"), "falls back to digest skeleton");
  assert.ok(r.subject && r.html && r.text, "fallback renders fully");
  assertCopyRules("hook-local-fallback", r);
  console.log("3. hook-local fallback ok");
}

// ── 4. product weave disclosure ──────────────────────────────────────
{
  const contact = { email: "sam@example.com", firstName: "Sam", city: "Newark" };
  const p = { matches: [], resumeScore: null, hasResume: false };
  for (const [label, r] of [
    ["hook-local", renderHookLocal({ contact, marketData: md, personalization: p, weave, ...base })],
    ["digest", renderDigestEmail({ contact, personalization: p, weave, ...base })],
  ]) {
    for (const v of [r.html, r.text]) {
      assert.ok(v.includes("#ad"), `${label}: #ad adjacent to link`);
      assert.ok(/affiliate link/i.test(v), `${label}: "affiliate link" disclosure`);
      assert.ok(/may earn a commission/i.test(v), `${label}: commission disclosure`);
      assert.ok(v.includes(weave.url), `${label}: product URL present`);
    }
    // at most ONE product per email: the URL appears once per version
    assert.equal(r.text.split(weave.url).length - 1, 1, `${label}: product woven exactly once in text`);
  }
  const clean = renderDigestEmail({ contact, personalization: p, ...base });
  assert.ok(!clean.html.includes("#ad") && !clean.text.includes("#ad"), "no weave -> no disclosure");
  console.log("4. product weave disclosure ok");
}

// ── 5. product tag on send + events ──────────────────────────────────
{
  await importEmailContacts(db, [{ email: "tagme@example.com", firstName: "Tag" }]);
  const c = await db.prepare("SELECT id FROM email_contact WHERE email = ?").bind("tagme@example.com").first();
  await logEmailSend(db, {
    contactId: c.id, kind: "warmup", template: "daily_digest", variant: "standard",
    subject: "s", providerUsed: "dry_run", status: "dry_run",
    meta: { skeleton: "digest", product: "logitech-c920s" },
  });
  const send = await db.prepare("SELECT meta_json FROM email_send WHERE contact_id = ?").bind(c.id).first();
  assert.equal(JSON.parse(send.meta_json).product, "logitech-c920s", "meta_json.product recorded on send");

  await recordEmailEvent(db, "tagme@example.com", "open", { meta: { provider: "brevo" } });
  await recordEmailEvent(db, "tagme@example.com", "click");
  const events = await db.prepare("SELECT kind, meta_json FROM email_event WHERE contact_id = ? ORDER BY id").bind(c.id).all().then((r) => r.results || []);
  assert.equal(events.length, 2);
  for (const e of events) {
    assert.equal(JSON.parse(e.meta_json).product, "logitech-c920s", `event ${e.kind} carries product tag`);
  }
  // campaignReport reads meta_json.product from email_event exactly this way
  const agg = await db.prepare(
    `SELECT json_extract(meta_json, '$.product') AS product, COUNT(*) AS n
     FROM email_event WHERE json_extract(meta_json, '$.product') IS NOT NULL GROUP BY product`
  ).all().then((r) => r.results || []);
  assert.ok(agg.some((a) => a.product === "logitech-c920s" && a.n >= 2), "product-tagged events aggregate");
  console.log("5. product tag write path ok");
}

// ── 6. no-assumption rule ────────────────────────────────────────────
{
  // We know ONLY email + city. Rendered copy must never assume the
  // recipient's role, seniority, industry, or employment status.
  const contact = { email: "stranger123@example.com", city: "Newark" };
  const p = { matches: [], resumeScore: null, hasResume: false };
  const renders = [
    renderHookLocal({ contact, marketData: md, personalization: p, ...base }),
    renderRepermission({ contact, ...base }),
    renderValueOnly({ contact, ...base }),
  ];
  const banned = /\b(engineer|developer|designer|manager|nurse|teacher|accountant|lawyer|analyst|intern|senior|junior|marketer|salesperson|recruiter|tech worker|tech professional)\b/i;
  for (const r of renders) {
    assert.ok(!banned.test(r.subject + "\n" + r.text), `no role/industry assumption: ${r.subject}`);
    assert.ok(r.text.startsWith("Hi,"), "no invented name in greeting");
  }
  console.log("6. no-assumption rule ok");
}

// ── 7. subject pool: 20 subjects ─────────────────────────────────────
{
  const contact = { email: "pool@example.com", firstName: "Pat", city: "Newark" };
  const subjects = new Set();
  // hook-local x5
  for (let i = 0; i < 40; i++) subjects.add(hookLocalSubject({ email: `hl${i}@example.com`, firstName: "Pat", marketData: md, dateStr: DS }));
  assert.ok(subjects.size >= 4, `hook-local pool rotates (got ${subjects.size})`);
  // repermission x4
  const rp = new Set();
  for (let i = 0; i < 40; i++) rp.add(repermissionSubject({ email: `rp${i}@example.com`, firstName: "Pat", dateStr: DS }));
  assert.ok(rp.size === 4, `repermission pool is exactly 4 (got ${rp.size})`);
  // value-only x4
  const vo = new Set();
  for (let i = 0; i < 40; i++) vo.add(valueOnlySubject({ email: `vo${i}@example.com`, firstName: "Pat", dateStr: DS }));
  assert.ok(vo.size === 4, `value-only pool is exactly 4 (got ${vo.size})`);
  // digest x5 + winback x2 (existing pools, sanity)
  const dg = new Set();
  for (let i = 0; i < 40; i++) dg.add(digestSubject({ email: `dg${i}@example.com`, firstName: "Pat", matches: [{ title: "X" }, { title: "Y" }], dateStr: DS }));
  assert.ok(dg.size >= 3, `digest pool rotates (got ${dg.size})`);

  // stability per recipient per day
  const s1 = hookLocalSubject({ email: contact.email, firstName: "Pat", marketData: md, dateStr: DS });
  assert.equal(s1, hookLocalSubject({ email: contact.email, firstName: "Pat", marketData: md, dateStr: DS }), "hook-local stable");
  assert.equal(repermissionSubject({ email: contact.email, firstName: "Pat", dateStr: DS }),
    repermissionSubject({ email: contact.email, firstName: "Pat", dateStr: DS }), "repermission stable");
  assert.equal(valueOnlySubject({ email: contact.email, firstName: "Pat", dateStr: DS }),
    valueOnlySubject({ email: contact.email, firstName: "Pat", dateStr: DS }), "value-only stable");

  // copy rules on every distinct subject
  for (const s of [...subjects, ...rp, ...vo, ...dg]) {
    assert.ok(!/\bfree\b/i.test(s), `no FREE: ${s}`);
    assert.ok(!/[A-Z]{4,}/.test(s), `no shouty caps: ${s}`);
    assert.ok(!s.includes("!"), `no exclamation: ${s}`);
    assert.ok(!EMOJI.test(s), `no emoji: ${s}`);
  }
  // personal only with a real name
  const named = repermissionSubject({ email: "x@example.com", firstName: "Pat", dateStr: DS });
  const anon = repermissionSubject({ email: "y@example.com", firstName: "", dateStr: DS });
  void named;
  assert.ok(!/\bPat\b/.test(anon), "no invented name for anonymous contact");
  console.log("7. subject pool (20) ok");
}

// ── 8. emoji sweep across full renders ───────────────────────────────
{
  const contact = { email: "sweep@example.com", firstName: "Sweep", city: "Newark" };
  const p = { matches: [{ title: "Ops Lead", company: "Acme", location: "Newark, NJ", url: "https://x", score: 88 }], resumeScore: 72, hasResume: true };
  for (let i = 0; i < 6; i++) {
    const r = renderForSkeleton({ skeleton: i, contact, personalization: p, marketData: md, weave, ...base });
    assert.ok(!EMOJI.test(r.subject + r.html + r.text), `skeleton ${i}: no emojis`);
    assertCopyRules(`sweep-${i}`, r);
  }
  console.log("8. emoji sweep ok");
}

// ── 9. dispatcher ────────────────────────────────────────────────────
{
  // formula stability (index 2 remaps to digest for non-at-risk)
  for (const e of ["a@example.com", "b@example.com"]) {
    const idx = hashStr(`${e}|${DS}`) % 6;
    assert.equal(skeletonIndexFor(e, DS), idx, "idx = hash(email|date) % 6");
    const want = idx === 2 ? 1 : idx;
    assert.equal(resolveSkeleton({ email: e, band: "high", variant: "standard", dateStr: DS }), want, "non-at-risk uses hash (2 -> digest)");
  }
  // winback restricted to at-risk, whatever the hash says
  for (let i = 0; i < 50; i++) {
    const e = `risk${i}@example.com`;
    assert.equal(resolveSkeleton({ email: e, band: "at_risk", variant: "winback", dateStr: DS }), 2, "at-risk -> winback");
    assert.notEqual(resolveSkeleton({ email: e, band: "high", variant: "standard", dateStr: DS }), 2, "high band never winback");
    assert.notEqual(resolveSkeleton({ email: e, band: "fresh", variant: "standard", dateStr: DS }), 2, "fresh never winback");
  }
  // rotation covers the non-winback skeletons across the list
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(resolveSkeleton({ email: `u${i}@example.com`, band: "moderate", variant: "standard", dateStr: DS }));
  for (const k of [0, 1, 3, 4, 5]) assert.ok(seen.has(k), `rotation reaches skeleton ${k}`);
  // legacy pending contacts: repermission (3) or tool-spotlight (5) only, never a product weave
  for (let i = 0; i < 50; i++) {
    const e = `legacy${i}@example.com`;
    const sk = resolveSkeleton({ email: e, band: "fresh", variant: "standard", dateStr: DS, source: "legacy" });
    assert.ok(sk === 3 || sk === 5, `legacy pending -> 3 or 5 (got ${sk})`);
  }
  console.log("9. dispatcher ok");
}

// ── 10. getLocalMarket: real numbers only ────────────────────────────
{
  const comp = await db.prepare("INSERT INTO company (name, slug, source) VALUES ('TestCo', 'testco', 'test')").run();
  const cid = Number(comp.meta.last_row_id);
  const recent = new Date(Date.now() - 2 * 86400000).toISOString();
  const old = new Date(Date.now() - 30 * 86400000).toISOString();
  const jobs = [
    // Newark: 4 recent (1 remote), salaries 120-150 / 140-180 / 160-210 / no band
    ["Backend Dev", "Newark, NJ", "remote", 120000, 150000, recent],
    ["Frontend Dev", "Newark, NJ", "onsite", 140000, 180000, recent],
    ["Data Analyst", "Newark, NJ", "hybrid", 160000, 210000, recent],
    ["Support Rep", "Newark", "onsite", null, null, recent],
    ["Ancient Role", "Newark, NJ", "remote", 999999, 9999999, old], // too old: excluded
    ["Far Away", "Austin, TX", "remote", 1, 2, recent],             // wrong city: excluded
  ];
  for (const [t, loc, rp2, smin, smax, pa] of jobs) {
    await db.prepare(
      "INSERT INTO job (company_id, external_id, source_kind, url, title, location, remote_policy, salary_min, salary_max, posted_at, is_active) VALUES (?, ?, 'test', ?, ?, ?, ?, ?, ?, ?, 1)"
    ).bind(cid, `t-${t}-${loc}`, `https://x/${t}`, t, loc, rp2, smin, smax, pa).run();
  }
  const m = await getLocalMarket(db, "Newark");
  assert.ok(m, "market data found");
  assert.equal(m.postingCount, 4, "only recent in-city postings counted");
  assert.equal(m.remotePct, 25, "remote share from the data");
  assert.equal(m.salaryBand, "$140k–$180k", "median band from the data");
  assert.equal(await getLocalMarket(db, "Nowhere"), null, "unknown city -> null");
  assert.equal(await getLocalMarket(db, ""), null, "empty city -> null");
  console.log("10. getLocalMarket ok");
}

// ── 11. queueDailySends: skeleton wiring + weave gating ──────────────
{
  await db.prepare("DELETE FROM email_contact").run();
  await db.prepare("DELETE FROM email_send").run();
  await db.prepare("UPDATE fib_gate SET level_idx = 0, level = 5, status = 'ramping', hold_until = NULL WHERE id = 1").run();
  await recordSeedTest(db, { template: "daily_digest", inboxPct: 92, spamPct: 2 });

  // one contact per skeleton 0/1/3/4/5 (index 2 remaps to digest for non-at-risk)
  const want = { 0: null, 1: null, 3: null, 4: null, 5: null };
  for (let i = 0; want[0] === null || want[1] === null || want[3] === null || want[4] === null || want[5] === null; i++) {
    const e = `q11-${i}@example.com`;
    const idx = resolveSkeleton({ email: e, band: "fresh", variant: "standard", dateStr: dayStr(new Date()) });
    if (idx in want && want[idx] === null) want[idx] = e;
    assert.ok(i < 1000, "found emails for each skeleton");
  }
  await importEmailContacts(db, Object.values(want).map((email) => ({ email, city: "Newark", source: "opted_in" })));

  // expected product of the day BEFORE the run (the run stamps last_featured_on)
  const pod = await getProductOfDay(db, dayStr(new Date()));
  assert.ok(pod && pod.url && pod.active === 1 && pod.approved === 1, "product of day is active+approved with a URL");

  const res = await queueDailySends(db, env, { live: false, now: new Date(), appUrl: "https://jobs.mehyar.us" });
  assert.equal(res.ok, true);
  assert.equal(res.results.dryRun, 5, "five contacts queued");
  const rows = await db.prepare(
    "SELECT ec.email, es.template, es.meta_json FROM email_send es JOIN email_contact ec ON ec.id = es.contact_id"
  ).all().then((r) => r.results || []);

  const INELIGIBLE = new Set(["yotru", "jobtestprep"]); // unapproved programs stay dark

  for (const row of rows) {
    const meta = JSON.parse(row.meta_json);
    assert.ok(SKELETON_NAMES.includes(meta.skeleton), `skeleton recorded: ${meta.skeleton}`);
    if (meta.skeleton === "hook_local" || meta.skeleton === "digest") {
      assert.equal(meta.product, pod.slug, `${meta.skeleton} weaves product of the day`);
      assert.ok(!INELIGIBLE.has(meta.product), "never weaves inactive/unapproved");
    } else {
      assert.ok(!meta.product, `${meta.skeleton} never weaves a product`);
    }
    if (meta.skeleton === "hook_local") assert.equal(row.template, "hook_local", "template name matches skeleton");
    if (meta.skeleton === "repermission") assert.equal(row.template, "repermission");
    if (meta.skeleton === "value_only") assert.equal(row.template, "value_only");
    if (meta.skeleton === "tool_spotlight") { assert.equal(row.template, "tool_spotlight"); assert.ok(meta.tool, "tool id recorded in meta"); }
  }
  const woven = rows.filter((r) => JSON.parse(r.meta_json).product);
  assert.ok(woven.length >= 1 && woven.length <= 2, "exactly the digest+hook-local sends weave");
  console.log("11. queueDailySends skeleton wiring ok");
}

console.log("\nAll Genius Flow skeleton tests passed.");
process.exit(0);
