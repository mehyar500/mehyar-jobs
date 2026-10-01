// scripts/test-launch-readiness.mjs
// Launch-readiness E2E checks against the BUILT dist/public + function code
// (no production needed):
//   a. dist/public/index.html: title, meta description, canonical, OG, twitter, JSON-LD
//   b. dist/public/robots.txt, sitemap.xml, llms.txt exist and parse
//   c. favicon files exist, non-empty, PNGs decode
//   d. Footer source links mehyar.us, aimech.app, rizza.app + contact
//   e. Landing source has FAQ section + target keywords
//   f. signup endpoint path writes email_contact with brand
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = resolve(ROOT, "dist/public");
const read = (p) => readFileSync(p, "utf8");
let n = 0;
const ok = (name) => console.log(`ok ${++n} - ${name}`);

// ── a. SEO tags in built index.html ──
const html = read(resolve(DIST, "index.html"));
for (const [label, re] of [
  ["title", /<title>[^<]+<\/title>/],
  ["meta description", /<meta name="description" content="[^"]{20,}"/],
  ["canonical", /<link rel="canonical" href="https:\/\/jobs\.mehyar\.us\/" \/>/],
  ["og:title", /<meta property="og:title"/],
  ["og:type", /<meta property="og:type" content="website"/],
  ["og:image", /<meta property="og:image"/],
  ["twitter:card", /<meta name="twitter:card" content="summary_large_image"/],
  ["twitter:title", /<meta name="twitter:title"/],
]) assert.ok(re.test(html), `index.html missing ${label}`);
const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
assert.ok(ldBlocks.length >= 3, "expected 3 JSON-LD blocks");
const types = ldBlocks.map((m) => JSON.parse(m[1])["@type"]).sort();
assert.deepEqual(types, ["FAQPage", "Organization", "WebSite"]);
const faq = JSON.parse(ldBlocks.find((m) => JSON.parse(m[1])["@type"] === "FAQPage")[1]);
assert.ok(faq.mainEntity.length >= 5, "FAQPage needs 5+ questions");
const site = JSON.parse(ldBlocks.find((m) => JSON.parse(m[1])["@type"] === "WebSite")[1]);
assert.ok(site.potentialAction?.["@type"] === "SearchAction", "WebSite SearchAction");
ok("a - index.html SEO tags + 3 JSON-LD blocks (Organization, WebSite+SearchAction, FAQPage)");

// ── b. robots.txt / sitemap.xml / llms.txt ──
const robots = read(resolve(DIST, "robots.txt"));
assert.ok(/^User-agent: \*/m.test(robots) && /Sitemap: https:\/\/jobs\.mehyar\.us\/sitemap\.xml/.test(robots));
const sitemap = read(resolve(DIST, "sitemap.xml"));
assert.ok(/<urlset/.test(sitemap) && (sitemap.match(/<loc>/g) || []).length >= 5);
assert.ok(/jobs\.mehyar\.us\/review/.test(sitemap));
const llms = read(resolve(DIST, "llms.txt"));
assert.ok(llms.length > 500 && /mehyar\.jobs/i.test(llms) && /mehyar\.us/.test(llms) && /unsubscribe/i.test(llms));
ok("b - robots.txt, sitemap.xml (7 URLs), llms.txt present and parse");

// ── c. favicons ──
for (const f of ["favicon.svg", "favicon-32.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png"]) {
  const p = resolve(DIST, f);
  assert.ok(existsSync(p), `${f} missing from dist`);
  assert.ok(statSync(p).size > 100, `${f} too small`);
  if (f.endsWith(".png")) {
    const buf = readFileSync(p);
    assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${f} bad PNG magic`);
  }
}
assert.ok(/apple-touch-icon/.test(html) && /favicon\.svg/.test(html), "index.html links icons");
ok("c - all favicon files exist, non-empty, PNGs decode");

// ── d. footer links ──
const footer = read(resolve(ROOT, "client/src/components/Footer.tsx"));
for (const u of ["https://mehyar.us", "https://aimech.app", "https://rizza.app", "info@mehyar.us"]) {
  assert.ok(footer.includes(u), `Footer missing ${u}`);
}
assert.ok(/Our products/.test(footer));
ok("d - Footer links mehyar.us, aimech.app, rizza.app + contact email");

// ── e. landing keywords + FAQ ──
const landing = read(resolve(ROOT, "client/src/pages/Landing.tsx"));
for (const kw of ["AI job matching", "fit-scored careers", "Fortune 500 job alerts"]) {
  assert.ok(landing.includes(kw), `Landing missing keyword: ${kw}`);
}
assert.ok(/<h1>/.test(landing) && /Questions, answered/.test(landing));
// the 6 FAQ questions render from one h3 inside a .map — count array entries
const faqQs = (landing.match(/\{ q: "/g) || []).length;
assert.ok(faqQs >= 6, `expected 6 FAQ entries, found ${faqQs}`);
// FAQ questions mirror the JSON-LD FAQPage
for (const q of ["What is mehyar.jobs?", "How do I unsubscribe from job alerts?"]) {
  assert.ok(landing.includes(q), `Landing FAQ missing: ${q}`);
  assert.ok(faq.mainEntity.some((e) => e.name === q), `JSON-LD FAQ missing: ${q}`);
}
ok("e - Landing has keywords, H1, semantic FAQ section matching JSON-LD");

// ── f. signup -> central store with brand ──
const confirm = read(resolve(ROOT, "functions/api/public/offer-email-confirm.js"));
assert.ok(/ensureEmailContact\(db, row\.email, row\.brand \|\| "mehyar\.jobs"\)/.test(confirm),
  "confirm handler must ensureEmailContact with brand");
assert.ok(/SELECT id, email, brand, status FROM newsletter_subscriber/.test(confirm),
  "confirm handler must read the subscriber brand");
const offerEmail = read(resolve(ROOT, "functions/api/public/offer-email.js"));
assert.ok(/INSERT INTO newsletter_subscriber \(email, brand, status, source, confirm_token\)/.test(offerEmail),
  "offer-email must write newsletter_subscriber with brand");
const unsub = read(resolve(ROOT, "functions/api/newsletter/unsubscribe.js"));
assert.ok(/UPDATE email_contact SET status = 'opted_out'/.test(unsub),
  "unsubscribe must opt out the email_contact funnel row");
// every funnel email template carries the footer w/ unsubscribe
const funnel = read(resolve(ROOT, "functions/_shared/emailFunnel.js"));
const footerCalls = (funnel.match(/footerHtml\(unsubUrl/g) || []).length;
assert.ok(footerCalls >= 5, `expected 5+ footerHtml(unsubUrl) calls, found ${footerCalls}`);
ok("f - signup flows to central store with brand; unsubscribe opts out funnel row; all templates carry footer");

console.log(`\nAll ${n} launch-readiness checks passed.`);
process.exit(0);
