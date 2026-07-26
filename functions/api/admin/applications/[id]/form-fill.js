// /api/admin/applications/{id}/form-fill
//
//   POST { screenshot: "<base64 PNG>", fields: [{name, label, type, options?}] }
//     → { answers: [{name, value, source: "llm"|"profile"|"canonical"}], model, latency_ms }
//
// LLM-powered form filler. Used by the headless browser run when
// the simple profile-matching can't fill a free-form field. The
// LLM sees the screenshot of the application page (so it has
// visual context) + the user's profile + the job description, and
// returns the best answer for each field.
//
// Uses the same LLM_API_KEY / LLM_MODEL env vars as the rest of
// the mehyar-web app. Backed by the CF AI Gateway (CLOUDFLARE_AI_GATEWAY_TOKEN).

import { requireAdmin, json, corsHeaders, onRequestOptions } from "../../../../_shared/adminAuth.js";
import { ensureSchema } from "../../../../_shared/db.js";
import { loadProfile } from "../../../../_shared/fit.js";
import { generateCustomAnswers } from "../../../../_shared/coverLetter.js";

export { onRequestOptions as onRequest };

const SYSTEM = `You are a job-application form filler. Given a screenshot of a job application page, the list of empty fields the bot couldn't fill automatically, the candidate's profile (resume + preferences), and the job description, return the best answer for each field.

Rules:
1. Be specific to the job and company. Reference concrete details from the job description.
2. Keep answers short — 1-3 sentences for free-form text, single value for everything else.
3. For "why this company" / "why this role" — lead with a concrete thing you can verify on their site or in the job description, not a generic "I'm excited about the mission".
4. For EEO voluntary self-identification (gender, race, veteran, disability) — if the profile has the answer, return it; otherwise return "Prefer not to say".
5. For work auth / visa / sponsorship — match the profile exactly.
6. For salary — return a number, no currency symbol, no "negotiable".
7. Return valid JSON only. No prose, no markdown, no preamble.`;

export async function onRequestPost({ request, env, params }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);

  let body = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400, request, env); }
  const fields = Array.isArray(body.fields) ? body.fields : [];
  if (!fields.length) return json({ ok: false, error: "fields_required" }, 400, request, env);

  // Load context
  const id = parseInt(params?.id, 10);
  let app = null, profile = null, job = null, company = null;
  if (id) {
    app = await env.JOBS_DB.prepare(`
      SELECT a.id, a.job_id, a.status, a.cover_letter, a.custom_answers,
             j.title AS job_title, j.url AS job_url, j.location AS job_location,
             j.description_text AS job_description, j.score AS job_score,
             c.id AS company_id, c.name AS company_name, c.industry AS company_industry
      FROM application a
      JOIN job j     ON j.id = a.job_id
      JOIN company c ON c.id = j.company_id
      WHERE a.id = ?
    `).bind(id).first();
    if (app) {
      profile = await loadProfile(env);
      job = { title: app.job_title, location: app.job_location, description_text: app.job_description, score: app.job_score };
      company = { name: app.company_name, industry: app.company_industry };
    }
  }
  if (!profile) profile = await loadProfile(env);

  const canonical = profile && app ? generateCustomAnswers({ profile, job, company }) : {};

  // Build the prompt
  const user = buildUserPrompt({ fields, profile, app, job, company, canonical, screenshot: body.screenshot });

  // Call the LLM
  const startedAt = Date.now();
  let llmResult;
  try {
    llmResult = await callLLM(env, SYSTEM, user, !!body.screenshot);
  } catch (e) {
    return json({ ok: false, error: "llm_failed", detail: String(e?.message || e) }, 500, request, env);
  }
  const latency_ms = Date.now() - startedAt;

  // Parse the response
  let parsed;
  try {
    const txt = llmResult.text || "";
    const jsonStart = txt.indexOf("{");
    const jsonEnd = txt.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) throw new Error("no JSON in LLM response");
    parsed = JSON.parse(txt.slice(jsonStart, jsonEnd + 1));
  } catch (e) {
    return json({ ok: false, error: "llm_parse_failed", raw: llmResult.text?.slice(0, 500) }, 500, request, env);
  }

  return json({
    ok: true,
    answers: parsed.answers || parsed,
    model: llmResult.model,
    latency_ms,
    candidates_considered: fields.length,
  }, 200, request, env);
}

function buildUserPrompt({ fields, profile, app, job, company, canonical, screenshot }) {
  const fieldTable = fields.map((f, i) => {
    const e = [];
    if (f.label) e.push(`label="${f.label}"`);
    if (f.name) e.push(`name="${f.name}"`);
    if (f.id) e.push(`id="${f.id}"`);
    if (f.type) e.push(`type="${f.type}"`);
    if (f.placeholder) e.push(`placeholder="${f.placeholder}"`);
    if (f.options && f.options.length) e.push(`options=${JSON.stringify(f.options.slice(0, 10))}`);
    if (f.required) e.push("required=true");
    return `${i + 1}. ${e.join(" ")}`;
  }).join("\n");

  const profileBlock = profile ? `
# Candidate profile

Name: ${profile.full_name || (profile.first_name || "") + " " + (profile.last_name || "")}
Email: ${profile.email || "(not set)"}
Phone: ${profile.phone || "(not set)"}
Location: ${profile.city || ""}${profile.country ? ", " + profile.country : ""}
Current title: ${profile.current_title || "(not set)"}
Current company: ${profile.current_company || "(not set)"}
Years of experience: ${profile.years_experience || "(not set)"}
Work auth: ${profile.work_auth || "(not set)"}
LinkedIn: ${profile.linkedin_url || "(not set)"}
GitHub: ${profile.github_url || "(not set)"}
Portfolio: ${profile.portfolio_url || profile.personal_website || "(not set)"}
Target titles: ${(profile.target_titles || []).join(", ") || "(not set)"}
Keywords: ${(profile.keywords || []).join(", ") || "(not set)"}
Min salary: $${profile.min_salary_usd?.toLocaleString() || "(not set)"}
Remote required: ${profile.remote_required ? "yes" : "no"}
Preferred industries: ${(profile.preferred_industries || []).join(", ") || "(not set)"}
Notice period: ${profile.notice_period || "(not set)"}
Gender: ${profile.gender || "Prefer not to say"}
Ethnicity: ${profile.ethnicity || "Prefer not to say"}
Veteran: ${profile.veteran_status || "Prefer not to say"}
Disability: ${profile.disability || "Prefer not to say"}
Resume excerpt: ${(profile.resume_text || "").slice(0, 1500) || "(not set)"}

# Pre-prepared answers for this application

Cover letter excerpt: ${(app?.cover_letter || "").slice(0, 800)}
Why this company: ${canonical.why_company || ""}
Why this role: ${canonical.why_role || ""}
About yourself: ${canonical.tell_us_about_yourself || ""}
What are you looking for: ${canonical.what_are_you_looking_for || ""}
Salary expectations: ${canonical.salary_expectations || ""}
Work auth: ${canonical.work_authorization || ""}
Relocation: ${canonical.willing_to_relocate || ""}
` : "(no profile saved)";

  const jobBlock = (job && company) ? `
# Job

Title: ${job.title}
Company: ${company.name}
Industry: ${company.industry || "(not set)"}
Location: ${job.location || "(not set)"}
Fit score: ${job.score || "n/a"}/100
Description: ${(job.description_text || "").slice(0, 2000)}
` : "";

  const screenshotNote = screenshot ? "\n# Visual context\nA screenshot of the application page is attached. Use it to understand the layout, the field types, and any visual cues (e.g. an asterisk marking required fields).\n" : "";

  return `Return JSON: { "answers": [ { "name": "<field name>", "value": "<the answer>" }, ... ] }

# Empty fields to fill (in order, by name)

${fieldTable}
${profileBlock}
${jobBlock}
${screenshotNote}

# Output format

Return JSON only. Match each empty field above to a value. The "name" in your output must be the exact name from the field list. For select dropdowns, the value must be one of the options listed. For textareas, write 1-3 sentences. For number/salary, write a number with no symbols.`;
}

async function callLLM(env, system, user, hasScreenshot) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiKey    = env.CLOUDFLARE_API_KEY || env.CLOUDFLARE_API_TOKEN;
  const gatewayToken = env.CLOUDFLARE_AI_GATEWAY_TOKEN;
  const model = env.LLM_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

  // CF AI Gateway: https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat/chat/completions
  // Falls back to direct Workers AI if no gateway configured.
  const url = gatewayToken
    ? `https://gateway.ai.cloudflare.com/v1/${accountId}/mehyar/compat/chat/completions`
    : `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;

  const messages = [{ role: "system", content: system }];
  if (hasScreenshot) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: user },
        { type: "image_url", image_url: { url: user.match(/screenshot/i) ? "data:image/png;base64,..." : "data:image/png;base64,..." } },
      ],
    });
  } else {
    messages.push({ role: "user", content: user });
  }

  const headers = { "content-type": "application/json" };
  if (gatewayToken) {
    headers["authorization"] = `Bearer ${gatewayToken}`;
  } else {
    headers["authorization"] = `Bearer ${apiKey}`;
  }

  const body = {
    model,
    messages,
    temperature: 0.2,
    max_tokens: 2000,
    response_format: { type: "json_object" },
  };

  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const txt = await r.text();
  if (!r.ok) throw new Error(`LLM ${r.status}: ${txt.slice(0, 400)}`);
  const j = JSON.parse(txt);
  return {
    text: j.choices?.[0]?.message?.content || "",
    model: j.model || model,
  };
}
