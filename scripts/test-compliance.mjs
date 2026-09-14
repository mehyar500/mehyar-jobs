// scripts/test-compliance.mjs
// Compliance audit tests (Worker 5):
//   1. physicalAddress(): env override (PHYSICAL_ADDRESS /
//      MAYOR_PHYSICAL_ADDRESS alias) else the clearly-marked placeholder.
//   2. Every skeleton footer carries the physical address in BOTH html
//      and text.
//   3. Footer copy is stream-aware: legacy stream gets honest language
//      ("your address was on a previous list", never claims an opt-in);
//      opted_in stream keeps the existing "asked for free job alerts"
//      copy. Legacy never says "asked for free job alerts" / "signed up";
//      opted-in never says "previous list".
//   4. Send path: queueDailySends stamps meta_json.stream = "legacy" for
//      source='legacy' contacts and "opted_in" otherwise.
//   5. Terms/Signup consent: Terms documents opt-in + one-click
//      unsubscribe; Signup's newsletter checkbox is unchecked by default
//      and passed through (not forced); the signup API no longer rejects
//      opt-out.
//   6. Copy rules still hold for both streams (no emojis, max one em
//      dash per render — the mandated legacy footer uses the single
//      allowed dash).
//   7. Zero "How it works" references remain in client/src.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureSchema } from "../functions/_shared/db.js";
import {
  PHYSICAL_ADDRESS_PLACEHOLDER, physicalAddress,
  renderDigestEmail, renderHookLocal, renderRepermission, renderValueOnly,
  renderForSkeleton, importEmailContacts, queueDailySends, recordSeedTest,
  SKELETON_NAMES,
} from "../functions/_shared/emailFunnel.js";

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

// ── 1. physicalAddress() ─────────────────────────────────────────────
{
  assert.equal(physicalAddress(), PHYSICAL_ADDRESS_PLACEHOLDER, "no env -> placeholder");
  assert.equal(physicalAddress({}), PHYSICAL_ADDRESS_PLACEHOLDER, "empty env -> placeholder");
  assert.ok(PHYSICAL_ADDRESS_PLACEHOLDER.includes("PLACEHOLDER"), "placeholder is clearly marked, not a real address");
  assert.equal(physicalAddress({ PHYSICAL_ADDRESS: "123 Main St, New York, NY 10001" }), "123 Main St, New York, NY 10001", "env override wins");
  assert.equal(physicalAddress({ MAYOR_PHYSICAL_ADDRESS: "456 Elm St" }), "456 Elm St", "MAYOR_PHYSICAL_ADDRESS alias works");
  assert.equal(physicalAddress({ PHYSICAL_ADDRESS: "  " }), PHYSICAL_ADDRESS_PLACEHOLDER, "blank env -> placeholder");
  console.log("1. physicalAddress() ok");
}

// ── 2/3. footer address + stream-aware copy on every renderer ─────────
const base = { unsubUrl: "https://jobs.mehyar.us/unsubscribe?token=t", appUrl: "https://jobs.mehyar.us", dateStr: DS };
const md = { city: "Newark", postingCount: 214, remotePct: 38, salaryBand: "$145k-$185k" };

{
  const contact = { email: "sam@example.com", firstName: "Sam", city: "Newark" };
  const p = { matches: [], resumeScore: null, hasResume: false };

  for (const stream of ["opted_in", "legacy"]) {
    const renders = [
      ["digest", renderDigestEmail({ contact, personalization: p, stream, ...base })],
      ["winback", renderDigestEmail({ contact, personalization: p, variant: "winback", stream, ...base })],
      ["hook-local", renderHookLocal({ contact, marketData: md, personalization: p, stream, ...base })],
      ["repermission", renderRepermission({ contact, stream, ...base })],
      ["value-only", renderValueOnly({ contact, stream, ...base })],
    ];
    // dispatcher: stream threads through every skeleton
    for (let i = 0; i < 5; i++) {
      const r = renderForSkeleton({ skeleton: i, contact, personalization: p, marketData: md, stream, ...base });
      renders.push([`skeleton-${SKELETON_NAMES[i]}`, r]);
    }

    for (const [label, r] of renders) {
      // address in both versions (placeholder in this env)
      assert.ok(r.html.includes(PHYSICAL_ADDRESS_PLACEHOLDER), `${label}/${stream}: address in html`);
      assert.ok(r.text.includes(PHYSICAL_ADDRESS_PLACEHOLDER), `${label}/${stream}: address in text`);
      // one-click unsubscribe present in both versions
      assert.ok(r.html.includes("unsubscribe") && r.html.includes(base.unsubUrl), `${label}/${stream}: unsub link in html`);
      assert.ok(r.text.includes(base.unsubUrl), `${label}/${stream}: unsub link in text`);

      if (stream === "legacy") {
        assert.ok(r.html.includes("your address was on a previous list"), `${label}/legacy: honest copy in html`);
        assert.ok(r.text.includes("your address was on a previous list"), `${label}/legacy: honest copy in text`);
        assert.ok(!/asked for free job alerts|signed up for/i.test(r.html + r.text), `${label}/legacy: never claims an opt-in`);
      } else {
        assert.ok(/asked for free job alerts/i.test(r.html + r.text), `${label}/opted_in: keeps existing copy`);
        assert.ok(!/previous list/i.test(r.html + r.text), `${label}/opted_in: no legacy language`);
      }

      // copy rules: no emojis, max one em dash per version
      for (const [k, v] of [["html", r.html], ["text", r.text]]) {
        assert.ok(!EMOJI.test(v), `${label}/${stream}: no emojis in ${k}`);
      }
      assert.ok(countEmDash(`${r.subject}\n${r.html}`) <= 1, `${label}/${stream}: max one em dash (html version)`);
      assert.ok(countEmDash(`${r.subject}\n${r.text}`) <= 1, `${label}/${stream}: max one em dash (text version)`);
    }
  }
  console.log("2/3. footer address + stream-aware copy ok");
}

// ── 4. send path: meta_json.stream per contact source ─────────────────
{
  await db.prepare("DELETE FROM email_contact").run();
  await db.prepare("DELETE FROM email_send").run();
  await db.prepare("UPDATE fib_gate SET level_idx = 0, level = 5, status = 'ramping', hold_until = NULL WHERE id = 1").run();
  await recordSeedTest(db, { template: "daily_digest", inboxPct: 92, spamPct: 2 });

  await importEmailContacts(db, [
    { email: "legacy-one@example.com", source: "legacy", city: "Newark" },
    { email: "member-one@example.com", source: "mehyar.jobs", city: "Newark" },
  ]);
  const res = await queueDailySends(db, env, { live: false, now: new Date(), appUrl: "https://jobs.mehyar.us" });
  assert.equal(res.ok, true, "dry run ok");
  assert.equal(res.results.dryRun, 2, "both contacts queued");
  const rows = await db.prepare(
    "SELECT ec.email, ec.source, es.meta_json FROM email_send es JOIN email_contact ec ON ec.id = es.contact_id"
  ).all().then((r) => r.results || []);
  for (const row of rows) {
    const meta = JSON.parse(row.meta_json);
    const want = row.source === "legacy" ? "legacy" : "opted_in";
    assert.equal(meta.stream, want, `${row.email} (source=${row.source}) stamps stream=${want}`);
  }
  console.log("4. send path stream threading ok");
}

// ── 5. Terms / Signup consent language ───────────────────────────────
{
  const terms = readFileSync("client/src/pages/Terms.tsx", "utf8");
  assert.ok(/opt-in/i.test(terms), "Terms documents opt-in consent");
  assert.ok(/separate from account creation/i.test(terms), "Terms: consent separate from account creation");
  assert.ok(/one-click unsubscribe/i.test(terms), "Terms: one-click unsubscribe");

  const signup = readFileSync("client/src/pages/Signup.tsx", "utf8");
  assert.ok(/useState\(false\)/.test(signup), "Signup: newsletter checkbox unchecked by default");
  assert.ok(/newsletter_opt_in:\s*newsletter/.test(signup), "Signup: passes the actual checkbox value (not forced true)");
  assert.ok(!/newsletter_required|Newsletter required/.test(signup), "Signup: no mandatory-newsletter block");

  const signupApi = readFileSync("functions/api/auth/signup.js", "utf8");
  assert.ok(!/newsletter_required/.test(signupApi), "signup API: opt-out no longer rejected");
  assert.ok(/newsletter \? 1 : 0/.test(signupApi), "signup API: stores the actual consent value");

  const privacy = readFileSync("client/src/pages/Privacy.tsx", "utf8");
  assert.ok(/separate, optional/i.test(privacy), "Privacy: newsletter is separate + optional");
  assert.ok(/one-click/i.test(privacy), "Privacy: one-click unsubscribe");
  console.log("5. Terms/Signup/Privacy consent ok");
}

// ── 7. zero "How it works" references in client/src ──────────────────
{
  const HIW = /how\s*it\s*works|howitworks|how-it-works/i;
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      const src = readFileSync(full, "utf8");
      for (const [i, line] of src.split("\n").entries()) {
        if (HIW.test(line)) hits.push(`${full}:${i + 1}: ${line.trim().slice(0, 90)}`);
      }
    }
  };
  walk("client/src");
  assert.deepEqual(hits, [], `zero "How it works" references in client/src:\n${hits.join("\n")}`);
  console.log("7. zero how-it-works references ok");
}

console.log("\nAll compliance tests passed.");
process.exit(0);
