import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const mode = args.mode || "review";
const headless = args.headless === true || String(args.headless).toLowerCase() === "true";
const applicationId = Number(args.application || 0);
if (!["review", "submit"].includes(mode)) fail("Usage: npm run local:apply -- --job-url <url> --material <file> --mode review|submit [--confirm APPLY]");
if (mode === "submit" && String(args.confirm) !== "APPLY") fail("Submit is blocked. Pass --confirm APPLY after reviewing the filled form.");

const profile = await loadProfile(path.join(root, "private", "mehyar-swelim-application-profile.md"));
await fs.access(profile.resumePath);
const remote = applicationId && process.env.MEHYAR_JOBS_TOKEN ? await remoteClient() : null;
const remoteApp = remote ? (await remote(`/api/admin/applications/${applicationId}`)).application : null;
const jobUrl = args["job-url"] || remoteApp?.job_url;
if (!jobUrl || !/(greenhouse\.io|ashbyhq\.com)/i.test(jobUrl)) fail("Provide a supported Greenhouse or Ashby --job-url.");
if (remoteApp?.status === "submitted") fail("This application is already submitted.");
const app = remoteApp || { job_url: jobUrl, job_title: args.title || "", company_name: args.company || "" };
const writer = await loadMaterial(args.material);
const runDir = path.join(root, "private", "runs", applicationId ? String(applicationId) : "local", new Date().toISOString().replace(/[:.]/g, "-"));
await fs.mkdir(runDir, { recursive: true });
await fs.writeFile(path.join(runDir, "cover-letter.txt"), writer.cover_letter + "\n", "utf8");

const browser = await chromium.launch({ headless, channel: "chrome" }).catch(() => chromium.launch({ headless }));
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const fields = [];
const log = [];
let outcome = "review_ready";
let error = "";
try {
  await page.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  if (/ashbyhq\.com/i.test(jobUrl)) await applyAshby(page, profile, fields, mode, writer, runDir);
  else await applyGreenhouse(page, profile, fields, mode, writer, runDir);
} catch (caught) {
  error = String(caught?.message || caught);
  outcome = /CAPTCHA|verification|required|not found/i.test(error) ? "needs_user_action" : "failed";
} finally {
  const screenshot = path.join(runDir, mode === "submit" ? "final.png" : "review.png");
  await page.screenshot({ path: screenshot, fullPage: true }).catch(() => null);
  const audit = { application_id: applicationId || null, mode, outcome, fields, writer, log, error, screenshot, final_url: page.url(), at: new Date().toISOString() };
  await fs.writeFile(path.join(runDir, "audit.json"), JSON.stringify(audit, null, 2));
  if (remote) await remote(`/api/admin/applications/${applicationId}/local-run`, { method: "POST", body: JSON.stringify({ outcome, fields, answers: writer.answers.map((a) => ({ question: a.question, answer: a.answer })), cover_letter: writer.cover_letter, final_url: page.url(), confirmation_detected: outcome === "submitted", log, error }) });
  console.log(JSON.stringify({ outcome, audit: path.relative(root, path.join(runDir, "audit.json")), browser_open: true, error }, null, 2));
  if (mode === "review") await new Promise(() => {});
  await browser.close();
}

async function applyGreenhouse(page, profile, fields, mode, writer, runDir) {
  await page.getByRole("button", { name: /apply now/i }).click({ timeout: 10_000 }).catch(() => null);
  await page.waitForTimeout(800);
  await fill(page, "#first_name", profile.firstName, "profile", fields);
  await fill(page, "#last_name", profile.lastName, "profile", fields);
  await fill(page, "#email", profile.email, "profile", fields);
  await fillSelect(page, "#country", "United States", "profile", fields);
  await fill(page, "#phone", profile.phoneInternational || profile.phoneDigits, "profile", fields);
  await fill(page, "#question_15806629004", profile.linkedin, "profile", fields);
  await fill(page, "#question_15806631004", profile.website, "profile", fields);
  await fillSelect(page, "#question_15806633004", "No", "profile", fields);
  await fill(page, "#location", profile.location, "profile", fields);
  await fill(page, "#question_15806634004", profile.location, "profile", fields);
  const resume = page.locator('input[type="file"][name*="resume" i], #resume input[type="file"], #resume');
  if (await resume.count()) { await resume.first().setInputFiles(profile.resumePath); fields.push({ label: "Resume/CV", value: profile.resumePath, source: "profile", attached: true }); }
  else throw new Error("Resume upload field was not found.");
  const letter = page.locator('textarea[name*="cover_letter" i], #cover_letter textarea');
  if (await letter.count()) { await letter.first().fill(writer.cover_letter); fields.push({ label: "Cover letter", value: writer.cover_letter, source: "llm" }); }
  else {
    const coverLetterFile = page.locator('input[type="file"][name*="cover" i], #cover_letter input[type="file"]');
    if (await coverLetterFile.count()) { await coverLetterFile.first().setInputFiles(path.join(runDir, "cover-letter.txt")); fields.push({ label: "Cover letter", value: path.join(runDir, "cover-letter.txt"), source: "llm", attached: true }); }
  }
  for (const answer of writer.answers) await fillAnswer(page, answer, fields);
  await fillRequiredGreenhouseDefaults(page, profile, fields);
  await fillRemainingRequiredFields(page, profile, writer, fields);
  await page.screenshot({ path: path.join(runDir, "review.png"), fullPage: true });
  if (mode === "submit") {
    await page.getByRole("button", { name: /submit application/i }).click({ timeout: 10_000 });
    await page.waitForTimeout(1500);
    if (await needsManualVerification(page)) {
      outcome = "needs_user_action";
      error = "The site requires a manual verification or otherwise blocks unattended submission.";
    } else {
      outcome = await confirmation(page) ? "submitted" : "needs_user_action";
      if (outcome !== "submitted") error = "The site did not provide a submission confirmation for unattended processing.";
    }
  }
}

async function applyAshby(page, profile, fields, mode, writer = { cover_letter: "", answers: [] }) {
  await page.getByRole("button", { name: /^apply/i }).first().click({ timeout: 10_000 }).catch(() => null);
  await page.waitForSelector('input[type="file"], #_systemfield_name, #_systemfield_resume', { timeout: 20_000 }).catch(() => null);
  await fill(page, "#_systemfield_name", `${profile.firstName} ${profile.lastName}`, "profile", fields);
  await fill(page, "#_systemfield_email", profile.email, "profile", fields);
  const resume = page.locator("#_systemfield_resume, input[type='file']").first();
  if (!await resume.count()) throw new Error("Resume upload field was not found.");
  await resume.setInputFiles(profile.resumePath);
  fields.push({ label: "Resume/CV", value: profile.resumePath, source: "profile", attached: true });
  await page.waitForTimeout(1200);
  await fillAshbyDefaults(page, profile, writer, fields);
  const onsite = page.getByText(/excited and able to work from our office 5 days a week/i);
  if (await onsite.count()) { await page.getByRole("button", { name: "Yes", exact: true }).click(); fields.push({ label: "Five days in New York office", value: "Yes", source: "profile" }); }
  const required = await page.locator("input[required], textarea[required], select[required]").evaluateAll((els) => els
    .filter((e) => (e.getAttribute("type") || "").toLowerCase() !== "file")
    .filter((e) => !e.value)
    .map((e) => e.id || e.getAttribute("name") || e.getAttribute("aria-label") || "unmapped"));
  if (required.length) throw new Error("Required Ashby fields remain unmapped: " + required.join(", "));
  await page.screenshot({ path: path.join(process.cwd(), "private", "runs", "ashby-review.png"), fullPage: true });
  if (mode !== "submit") return;
  await page.getByRole("button", { name: /submit application/i }).click({ timeout: 10_000 });
  await page.waitForTimeout(1500);
  if (await needsManualVerification(page)) { outcome = "needs_user_action"; error = "The site requires a manual verification or otherwise blocks unattended submission."; }
  else { outcome = await confirmation(page) ? "submitted" : "needs_user_action"; if (outcome !== "submitted") error = "The site did not provide a submission confirmation for unattended processing."; }
}

async function fillAshbyDefaults(page, profile, writer, fields) {
  await fill(page, 'input[type="tel"]', profile.phoneDigits || profile.phone, "profile.phone", fields);
  await fillAshbyLocation(page, profile.location || "Brooklyn, New York, United States", fields);
  await fillPlaceholder(page, /pick date/i, "08/03/2026", "profile.availability", fields);
  await fillPlaceholder(page, /type here/i, "Mehyar", "profile.preferred_name", fields, false, /preferred name/i);
  await fillTextareaContext(page, /additional information|motivation/i, writer.cover_letter, "writer.cover_letter", fields);
  await page.locator('textarea[placeholder*="Type here" i]').first().fill(writer.cover_letter.slice(0, 1800)).then(() => {
    fields.push({ label: "Ashby additional information", value: writer.cover_letter.slice(0, 1800), source: "writer.cover_letter" });
  }).catch(() => null);
  await fillEmptyAshbyTextareas(page, writer.cover_letter, fields);
  await clickAshbyButton(page, /authorized to work/i, /^yes$/i, "Yes", fields);
  await clickAshbyButton(page, /sponsorship|visa/i, /^no$/i, "No", fields);
  await clickAshbyButton(page, /office three days|three days per week|from our.*office/i, /^yes$/i, "Yes", fields);
  await page.locator('input[type="checkbox"]').evaluateAll((items) => {
    for (const item of items) {
      const text = item.name || item.id || item.closest("label")?.textContent || item.parentElement?.textContent || "";
      if (/acknowledge|confirm|read|agree/i.test(text)) item.click();
    }
  }).catch(() => null);
  fields.push({ label: "Ashby acknowledgements", value: "checked", source: "profile.default" });
  await checkAshbyRadio(page, /gender/i, /decline/i, fields);
  await checkAshbyRadio(page, /race/i, /decline/i, fields);
  await checkAshbyRadio(page, /veteran/i, /not a protected veteran|decline/i, fields);
  await checkAshbyRadio(page, /disability/i, /do not want|no, i don't/i, fields);
  await checkAnyVisibleRadio(page, /decline to self-identify|i decline to self-identify|i am not a protected veteran|i do not want to answer|no, i don't/i, fields);
}

async function fillPlaceholder(page, pattern, value, source, fields, enter = false, contextPattern = null) {
  const items = page.locator("input, textarea");
  for (let i = 0; i < await items.count(); i++) {
    const item = items.nth(i);
    const placeholder = await item.getAttribute("placeholder").catch(() => "");
    if (!pattern.test(placeholder || "")) continue;
    if (contextPattern) {
      const text = await item.evaluate((el) => {
        let n = el;
        for (let i = 0; n && i < 5; i++, n = n.parentElement) {
          const text = (n.textContent || "").replace(/\s+/g, " ");
          if (text.length > 15) return text;
        }
        return "";
      }).catch(() => "");
      if (!contextPattern.test(text)) continue;
    }
    const current = await item.inputValue().catch(() => "");
    if (current) continue;
    await item.fill(value).catch(() => null);
    if (enter) await item.press("Enter").catch(() => null);
    fields.push({ label: String(pattern), value, source });
    return true;
  }
  return false;
}

async function fillAshbyLocation(page, value, fields) {
  const input = page.locator('input[role="combobox"][placeholder*="Start typing" i]').first();
  if (!await input.count().catch(() => 0)) return false;
  await input.scrollIntoViewIfNeeded().catch(() => null);
  await input.click({ force: true }).catch(() => null);
  await input.fill("").catch(() => null);
  await input.pressSequentially("Brooklyn", { delay: 20 }).catch(() => null);
  await input.page().waitForTimeout(500).catch(() => null);
  await input.press("ArrowDown").catch(() => null);
  await input.press("Enter").catch(() => null);
  await input.page().waitForTimeout(300).catch(() => null);
  fields.push({ label: "Ashby location", value, source: "profile.location" });
  return true;
}

async function fillEmptyAshbyTextareas(page, value, fields) {
  if (!value) return;
  const areas = page.locator("textarea");
  for (let i = 0; i < await areas.count(); i++) {
    const area = areas.nth(i);
    if (!await area.isVisible().catch(() => false)) continue;
    const name = await area.getAttribute("name").catch(() => "");
    if (/g-recaptcha/i.test(name || "")) continue;
    const current = await area.inputValue().catch(() => "");
    if (current) continue;
    await area.fill(value.slice(0, 1800)).catch(() => null);
    fields.push({ label: "Ashby textarea", value: value.slice(0, 1800), source: "writer.cover_letter" });
  }
}

async function fillTextareaContext(page, contextPattern, value, source, fields) {
  if (!value) return false;
  const areas = page.locator("textarea");
  for (let i = 0; i < await areas.count(); i++) {
    const area = areas.nth(i);
    const text = await area.evaluate((el) => {
      let n = el;
      for (let i = 0; n && i < 6; i++, n = n.parentElement) {
        const text = (n.textContent || "").replace(/\s+/g, " ");
        if (text.length > 20) return text;
      }
      return "";
    }).catch(() => "");
    if (!contextPattern.test(text)) continue;
    const current = await area.inputValue().catch(() => "");
    if (current) continue;
    await area.fill(value.slice(0, 1800)).catch(() => null);
    fields.push({ label: text.slice(0, 120), value: value.slice(0, 1800), source });
    return true;
  }
  return false;
}

async function clickAshbyButton(page, questionPattern, optionPattern, value, fields) {
  const clicked = await page.evaluate(({ q, o }) => {
    const question = new RegExp(q, "i");
    const option = new RegExp(o, "i");
    for (const el of document.querySelectorAll("div, section, fieldset")) {
      const text = (el.textContent || "").replace(/\s+/g, " ");
      if (!question.test(text)) continue;
      const buttons = [...el.querySelectorAll("button")];
      const button = buttons.find((b) => option.test((b.textContent || "").trim()));
      if (button) { button.click(); return true; }
    }
    return false;
  }, { q: questionPattern.source, o: optionPattern.source }).catch(() => false);
  if (clicked) fields.push({ label: String(questionPattern), value, source: "profile.default" });
  return clicked;
}

async function checkAshbyRadio(page, groupPattern, optionPattern, fields) {
  const checked = await page.evaluate(({ g, o }) => {
    const group = new RegExp(g, "i");
    const option = new RegExp(o, "i");
    for (const input of document.querySelectorAll('input[type="radio"]')) {
      const container = input.closest("section, fieldset, div");
      const text = (container?.textContent || "").replace(/\s+/g, " ");
      if (group.test(text) && option.test(text)) { input.click(); return text.slice(0, 120); }
    }
    return "";
  }, { g: groupPattern.source, o: optionPattern.source }).catch(() => "");
  if (checked) fields.push({ label: checked, value: "selected", source: "profile.default" });
  return !!checked;
}

async function checkAnyVisibleRadio(page, optionPattern, fields) {
  const count = await page.locator('input[type="radio"]').count();
  for (let i = 0; i < count; i++) {
    const radio = page.locator('input[type="radio"]').nth(i);
    if (!await radio.isVisible().catch(() => false)) continue;
    const checked = await radio.isChecked().catch(() => false);
    if (checked) continue;
    const text = await radio.evaluate((el) => (el.closest("label")?.textContent || el.parentElement?.textContent || "").replace(/\s+/g, " ")).catch(() => "");
    if (!optionPattern.test(text)) continue;
    await radio.check({ force: true }).catch(() => null);
    fields.push({ label: text.slice(0, 120), value: "selected", source: "profile.default" });
  }
}

async function loadMaterial(file) {
  if (!file) fail("Pass --material <path>. Codex authors this private JSON; no API key is used.");
  let parsed; try { parsed = JSON.parse(await fs.readFile(path.resolve(root, file), "utf8")); } catch { fail("Application material must be valid JSON."); }
  if (!parsed?.cover_letter || typeof parsed.cover_letter !== "string" || parsed.cover_letter.length > 2200 || !Array.isArray(parsed.answers) || !Array.isArray(parsed.facts_used) || parsed.facts_used.length === 0) fail("Application material must include a cover letter, answers, and the resume/profile facts used.");
  return { cover_letter: parsed.cover_letter.trim(), answers: parsed.answers.filter((x) => typeof x?.question === "string" && typeof x?.answer === "string").slice(0, 20), facts_used: parsed.facts_used, needs_review: parsed.needs_review || [] };
}

async function remoteClient() { const base = (process.env.JOBS_BASE_URL || "https://jobs.mehyar.us").replace(/\/$/, ""); const token = process.env.MEHYAR_JOBS_TOKEN; if (!token) fail("Set MEHYAR_JOBS_TOKEN in this local shell."); return async (url, init = {}) => { const response = await fetch(base + url, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers || {}) } }); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(`${response.status} ${body.error || "remote request failed"}`); return body; }; }
async function loadProfile(file) { const text = await fs.readFile(file, "utf8"); const val = (name) => (text.match(new RegExp(`^- ${name}:\\s*(.+)$`, "mi")) || [])[1]?.replace(/`/g, "").trim() || ""; const fullName = val("Full name"); const [firstName, ...rest] = fullName.split(/\s+/); const phone = val("Phone"); const digits = phone.replace(/\D/g, ""); const p = { firstName, lastName: rest.join(" "), email: val("Email"), phoneDigits: digits, phoneInternational: digits.length === 10 ? `+1 ${digits.slice(0,3)} ${digits.slice(3,6)} ${digits.slice(6)}` : phone, location: val("Location"), website: val("Website"), linkedin: val("LinkedIn"), resumePath: val("Resume source"), writerProfile: text.replace(/## Optional EEO Responses[\s\S]*?(?=##|$)/, "") }; if (!p.firstName || !p.lastName || !p.email || !p.resumePath) fail("Private application profile is incomplete."); return p; }
async function fill(page, selector, value, source, fields) { if (!value) return; const loc = page.locator(selector); if (await loc.count()) { await loc.first().fill(value); fields.push({ label: selector, value, source }); } }
async function fillSelect(page, selector, value, source, fields) {
  const loc = page.locator(selector);
  if (!value || !await loc.count()) return;
  await loc.first().fill(value);
  await loc.first().press("ArrowDown");
  await loc.first().press("Enter");
  fields.push({ label: selector, value, source });
}
async function fillAnswer(page, answer, fields) { const labels = page.locator("label"); for (let i = 0; i < await labels.count(); i++) { const label = labels.nth(i); const text = (await label.innerText().catch(() => "")).trim(); if (text && text.toLowerCase() === answer.question.toLowerCase()) { const id = await label.getAttribute("for"); if (id) { const target = page.locator(`[id="${id.replace(/"/g, "\\\\\"")}"]`); if (await target.count()) { const first = target.first(); const type = await first.getAttribute("type").catch(() => ""); if (type === "checkbox" || type === "radio") { await first.check({ force: true }).catch(() => null); fields.push({ label: text, value: "checked", source: "llm" }); return; } await first.fill(answer.answer); fields.push({ label: text, value: answer.answer, source: "llm" }); return; } } } } }
async function fillRequiredGreenhouseDefaults(page, profile, fields) {
  await fillLabel(page, /location.*city|current location|location/i, profile.location, "profile.location", fields);
  await fillLabel(page, /linkedin/i, profile.linkedin, "profile.linkedin", fields);
  await fillLabel(page, /website|portfolio/i, profile.website, "profile.website", fields);
  await fillLabel(page, /how did you hear|source/i, "Company careers page", "profile.default", fields);
  await fillLabel(page, /current.*company|most recent.*company|employer/i, "Foragr.ai / independent consulting", "profile.default", fields);
  await chooseLabel(page, /authorized.*work|work.*authorized|eligible.*work/i, [/^yes$/i, /authorized/i], "Yes", fields);
  await chooseLabel(page, /open.*working.*office|in-person.*office|25%.*time|office.*25/i, [/^yes$/i], "Yes", fields);
  await chooseLabel(page, /sponsor|immigration/i, [/^no$/i, /not require/i], "No", fields);
  await chooseLabel(page, /privacy|data.*process|certify|information.*provided|ai policy|artificial intelligence|machine learning|interview.*record|transcribed/i, [/^yes$/i, /i agree/i, /agree/i, /acknowledge/i], "Yes", fields);
  await chooseLabel(page, /gender|race|ethnic|hispanic|latino|disability|veteran|military|lgbtq|sexual|pronoun/i, [/prefer not/i, /decline/i, /i do not wish/i, /^no$/i], "Prefer not to answer", fields);
  const consentBoxes = page.locator('input[type="checkbox"][required], label:has-text("consent") input[type="checkbox"], label:has-text("Privacy") input[type="checkbox"]');
  for (let i = 0; i < await consentBoxes.count(); i++) {
    const box = consentBoxes.nth(i);
    if (await box.isVisible().catch(() => false)) {
      await box.check({ force: true }).catch(() => null);
      fields.push({ label: "required checkbox", value: "checked", source: "profile.default" });
    }
  }
}
async function fillRemainingRequiredFields(page, profile, writer, fields) {
  const controls = page.locator("input, textarea, select");
  for (let i = 0; i < await controls.count(); i++) {
    const control = controls.nth(i);
    if (!await control.isVisible().catch(() => false)) continue;
    const meta = await control.evaluate((el) => {
      const id = el.id || "";
      const name = el.getAttribute("name") || "";
      const type = (el.getAttribute("type") || "").toLowerCase();
      const role = el.getAttribute("role") || "";
      const tag = el.tagName.toLowerCase();
      const required = el.required || el.getAttribute("aria-required") === "true" || !!el.closest(".field.required, .required");
      const label = id
        ? (document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent || "")
        : "";
      const group = el.closest(".field, .question, .application-question, div");
      return { id, name, type, role, tag, required, label, context: group?.textContent || "" };
    }).catch(() => null);
    if (!meta || !meta.required || meta.type === "hidden" || meta.type === "file" || meta.type === "submit") continue;
    const current = await control.inputValue().catch(() => "");
    if (current && meta.tag !== "select") continue;
    const hay = `${meta.label} ${meta.context} ${meta.name}`.replace(/\s+/g, " ").trim();
    if (meta.role === "combobox" || /select__input/.test(String(meta.id) + " " + String(meta.context))) {
      const answer = comboAnswerFor(hay, profile, writer);
      if (answer) {
        await chooseCombobox(control, answer);
        fields.push({ label: hay.slice(0, 120), value: answer, source: "required.combobox" });
      }
      continue;
    }
    if (meta.tag === "select") {
      if (current) continue;
      const options = await control.locator("option").evaluateAll((items) => items.map((o) => ({ value: o.value, text: o.textContent || "" }))).catch(() => []);
      const answer = answerFor(hay, profile, writer);
      const picked = pickOption(options, hay, answer);
      if (picked) {
        await control.selectOption(picked.value).catch(() => null);
        fields.push({ label: hay.slice(0, 120), value: picked.text.trim(), source: "required.default" });
      }
      continue;
    }
    if (meta.type === "checkbox") {
      await control.check({ force: true }).catch(() => null);
      fields.push({ label: hay.slice(0, 120), value: "checked", source: "required.default" });
      continue;
    }
    if (meta.type === "radio") {
      const value = /sponsor|visa/i.test(hay) ? "No" : "Yes";
      await chooseLabel(page, new RegExp(escapeRegex(hay.slice(0, 30)), "i"), [new RegExp(`^${value}$`, "i"), /prefer not/i], value, fields).catch(() => null);
      continue;
    }
    if (current) continue;
    const answer = answerFor(hay, profile, writer);
    await control.fill(answer).catch(() => null);
    fields.push({ label: hay.slice(0, 120), value: answer, source: "required.default" });
  }
}
async function chooseCombobox(control, answer) {
  await control.scrollIntoViewIfNeeded().catch(() => null);
  await control.page().keyboard.press("Escape").catch(() => null);
  await control.page().mouse.click(20, 20).catch(() => null);
  await control.page().waitForTimeout(100).catch(() => null);
  await control.click({ force: true }).catch(() => null);
  await control.fill("").catch(() => null);
  await control.pressSequentially(answer, { delay: 15 }).catch(async () => {
    await control.fill(answer).catch(() => null);
  });
  await control.page().waitForTimeout(250).catch(() => null);
  await control.press("Enter").catch(() => null);
  await control.page().waitForTimeout(150).catch(() => null);
  const stillEmpty = await control.evaluate((el) => {
    const text = el.closest("div")?.textContent || "";
    return /select\.\.\./i.test(text) || !el.value;
  }).catch(() => false);
  if (stillEmpty) {
    await control.click({ force: true }).catch(() => null);
    await control.press("ArrowDown").catch(() => null);
    await control.press("Enter").catch(() => null);
  }
  await control.page().waitForTimeout(150).catch(() => null);
}
function comboAnswerFor(label, profile, writer) {
  const hay = String(label || "").toLowerCase();
  if (/relocation/.test(hay)) return "No";
  if (/office|in-person|25%/.test(hay)) return "Yes";
  if (/interviewed.*before|anthropic before/.test(hay)) return "No";
  if (/sponsor|visa/.test(hay)) return "No";
  if (/discover.*different|safety matters|ai policy|collaborating with ai|artificial intelligence|machine learning/.test(hay)) return "Yes";
  if (/years.*experience|software engineer/.test(hay)) return "10+";
  if (/gender|hispanic|latino|race|ethnic|veteran|disability|military/.test(hay)) return "Prefer not";
  return answerFor(label, profile, writer);
}
function answerFor(label, profile, writer) {
  const hay = String(label || "").toLowerCase();
  const find = (pattern) => (writer.answers || []).find((a) => pattern.test(a.question || ""))?.answer || "";
  if (/why.*anthropic|why.*company|why.*us|why.*interested|why.*role/.test(hay)) return find(/why.*company|why.*role|interested/i) || writer.cover_letter.slice(0, 1000);
  if (/values|challenge|technical|problem|accomplishment|project|most proud/.test(hay)) return "I am strongest on ambiguous systems work where the useful answer is not obvious at the start. I usually begin by reducing the problem to user impact, operational constraints, and the smallest reliable path to production, then iterate with evidence rather than preference.";
  if (/additional information|anything else|comments/i.test(hay)) return "Thank you for reviewing my application. I would be glad to walk through relevant systems, AI, automation, and platform work in more detail.";
  if (/current.*company|most recent.*company|employer/.test(hay)) return "Foragr.ai / independent consulting";
  if (/office|in-person|25%|ai policy|artificial intelligence|machine learning|record|transcrib|privacy|certify|information.*provided/.test(hay)) return "Yes";
  if (/location|city/.test(hay)) return profile.location || "Brooklyn, New York, United States";
  if (/linkedin/.test(hay)) return profile.linkedin || "";
  if (/website|portfolio/.test(hay)) return profile.website || "";
  if (/hear|source/.test(hay)) return "Company careers page";
  if (/sponsor|visa/.test(hay)) return "No";
  if (/authorized|eligible.*work/.test(hay)) return "Yes";
  if (/salary|compensation/.test(hay)) return "USD 130,000 to USD 190,000 base salary annually; flexible based on scope and total compensation.";
  return writer.cover_letter.slice(0, 1200);
}
function pickOption(options, label, answer) {
  const hay = String(label || "").toLowerCase();
  const nonEmpty = options.filter((o) => o.value && !/select/i.test(o.text));
  const prefer = (...patterns) => nonEmpty.find((o) => patterns.some((re) => re.test(o.text)));
  if (/sponsor|visa/.test(hay)) return prefer(/^no\b/i, /not require/i) || nonEmpty[0];
  if (/authorized|eligible.*work|office|onsite|hybrid|privacy|certify|information.*provided|terms|policy/.test(hay)) return prefer(/^yes\b/i, /agree/i, /acknowledge/i) || nonEmpty[0];
  if (/gender|race|ethnic|hispanic|latino|disability|veteran|military|lgbtq|sexual|pronoun/.test(hay)) return prefer(/prefer not/i, /decline/i, /i do not wish/i, /^no\b/i) || nonEmpty[0];
  if (/hear|source/.test(hay)) return prefer(/company/i, /careers/i, /website/i, /online/i, /linkedin/i) || nonEmpty[0];
  if (answer) return prefer(new RegExp(escapeRegex(answer), "i")) || nonEmpty[0];
  return nonEmpty[0];
}
async function fillLabel(page, pattern, value, source, fields) {
  if (!value) return false;
  const control = page.getByLabel(pattern).first();
  if (!await control.count().catch(() => 0)) return false;
  const tag = await control.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
  const type = await control.getAttribute("type").catch(() => "");
  if (type === "hidden" || type === "file" || type === "checkbox" || type === "radio") return false;
  const current = await control.inputValue().catch(() => "");
  if (current) return false;
  if (tag === "select") return chooseSelect(control, [new RegExp(escapeRegex(value), "i"), /prefer not/i, /^yes$/i], value, fields, source);
  await control.fill(value).catch(() => null);
  fields.push({ label: String(pattern), value, source });
  return true;
}
async function chooseLabel(page, pattern, preferred, value, fields) {
  const control = page.getByLabel(pattern).first();
  if (!await control.count().catch(() => 0)) return false;
  const tag = await control.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
  const type = await control.getAttribute("type").catch(() => "");
  if (tag === "select") return chooseSelect(control, preferred, value, fields, "profile.default");
  if (type === "checkbox") {
    await control.check({ force: true }).catch(() => null);
    fields.push({ label: String(pattern), value: "checked", source: "profile.default" });
    return true;
  }
  if (type === "radio") {
    for (const option of preferred) {
      const radio = page.getByLabel(option).first();
      if (await radio.count().catch(() => 0)) {
        await radio.check({ force: true }).catch(() => null);
        fields.push({ label: String(pattern), value, source: "profile.default" });
        return true;
      }
    }
  }
  const current = await control.inputValue().catch(() => "");
  if (!current) await control.fill(value).catch(() => null);
  fields.push({ label: String(pattern), value, source: "profile.default" });
  return true;
}
async function chooseSelect(control, preferred, value, fields, source) {
  const options = await control.locator("option").evaluateAll((items) => items.map((o) => ({ value: o.value, text: o.textContent || "" }))).catch(() => []);
  const picked = options.find((o) => preferred.some((re) => re.test(o.text))) || options.find((o) => o.value && !/select/i.test(o.text));
  if (!picked) return false;
  await control.selectOption(picked.value).catch(() => null);
  fields.push({ label: "select", value: picked.text.trim() || value, source });
  return true;
}
function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
async function needsManualVerification(page) {
  const visibleFrame = await page.locator('iframe[src*="captcha" i], iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i]').evaluateAll((frames) => frames.some((frame) => {
    const src = frame.getAttribute("src") || "";
    if (/size=invisible/i.test(src)) return false;
    const rect = frame.getBoundingClientRect();
    return rect.width > 80 && rect.height > 40;
  }));
  const challengeText = await page.getByText(/verify you are human|complete the captcha|security code|check your email/i).count();
  const verificationInput = await page.locator('input[aria-label*="security code" i], input[placeholder*="security code" i], input[name*="verification" i], input[id*="verification" i]').count();
  return visibleFrame > 0 || challengeText > 0 || verificationInput > 0;
}
async function confirmation(page) { return await page.locator('text=/thank you|application has been submitted|received your application/i').count() > 0; }
function parseArgs(items) { const out = {}; for (let i = 0; i < items.length; i++) if (items[i].startsWith("--")) out[items[i].slice(2)] = items[i + 1]?.startsWith("--") ? true : items[++i]; return out; }
function fail(message) { console.error(message); process.exit(1); }
