import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const limit = Math.max(1, Math.min(50, Number(args.limit || 20)));
const discoveryPath = path.resolve(root, args.input || "private/discovery/latest-matches.json");
const outputPath = path.resolve(root, args.output || "private/discovery/ats-preflight.json");
const discovered = JSON.parse(await fs.readFile(discoveryPath, "utf8"));
const selected = chooseDiverse(discovered.matches || discovered.items || [], limit);
const browser = await chromium.launch({ headless: true, channel: "chrome" }).catch(() => chromium.launch({ headless: true }));
const results = [];
let cursor = 0;
await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
  while (cursor < selected.length) {
    const job = selected[cursor++];
    results.push(await inspect(browser, job));
  }
}));
await browser.close();
const summary = Object.groupBy(results, (result) => result.classification);
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, JSON.stringify({ generated_at: new Date().toISOString(), tested: results.length, summary: Object.fromEntries(Object.entries(summary).map(([key, value]) => [key, value.length])), results }, null, 2) + "\n");
console.log(JSON.stringify({ output: path.relative(root, outputPath), tested: results.length, summary: Object.fromEntries(Object.entries(summary).map(([key, value]) => [key, value.length])) }, null, 2));

async function inspect(browser, job) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const provider = providerFor(job.url);
  try {
    await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 25_000 });
    await page.getByRole("button", { name: /apply now|apply for this job|^apply$/i }).first().click({ timeout: 4_000 }).catch(() => null);
    await page.waitForTimeout(600);
    const labels = (await page.locator("label").allTextContents()).map((text) => text.replace(/\s+/g, " ").trim()).filter(Boolean);
    const fields = await page.locator("input, textarea, select").evaluateAll((elements) => elements.map((element) => ({ type: element.getAttribute("type") || element.tagName.toLowerCase(), required: element.required, name: element.getAttribute("name") || element.id || element.getAttribute("aria-label") || "" })));
    const custom = labels.filter((label) => !/^(first name|last name|name|email|country|phone|location|resume|attach|enter manually|linkedin|website|github|portfolio|preferred pronouns|gender|race|veteran status|disability status)/i.test(label.replace(/\*$/, "").trim()));
    const verification = await page.getByText(/security code|verify you are human|check your email|captcha/i).count() > 0;
    const hasResume = fields.some((field) => field.type === "file") || /resume/i.test(labels.join(" "));
    const classification = verification ? "visible_verification" : !hasResume ? "no_resume_field" : custom.length ? "custom_questions" : "core_fields_only";
    return { company: job.company, title: job.title, url: job.url, provider, classification, has_resume: hasResume, custom_questions: custom.slice(0, 20), field_count: fields.length };
  } catch (error) {
    return { company: job.company, title: job.title, url: job.url, provider, classification: "unreachable_or_unsupported", error: String(error?.message || error).slice(0, 300) };
  } finally { await page.close(); }
}

function chooseDiverse(items, limit) {
  const selected = [];
  const seen = new Set();
  for (const item of items) {
    const key = item.url;
    if (seen.has(key)) continue;
    seen.add(key); selected.push(item);
    if (selected.length >= limit) break;
  }
  return selected;
}
function providerFor(url) { const value = String(url || "").toLowerCase(); if (value.includes("ashbyhq")) return "ashby"; if (value.includes("greenhouse")) return "greenhouse"; if (value.includes("lever.co")) return "lever"; if (value.includes("workday")) return "workday"; if (value.includes("smartrecruiters")) return "smartrecruiters"; return "company_site"; }
function parseArgs(items) { const out = {}; for (let i = 0; i < items.length; i++) if (items[i].startsWith("--")) out[items[i].slice(2)] = items[i + 1]?.startsWith("--") ? true : items[++i]; return out; }
