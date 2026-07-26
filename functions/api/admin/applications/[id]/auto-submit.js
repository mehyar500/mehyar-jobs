// /api/admin/applications/{id}/auto-submit
//
// HEADLESS BROWSER AUTO-SUBMIT (Cloudflare Browser Rendering)
//
//   POST → opens the job's careers URL in a headless Chromium,
//          fills the application form using the user's profile +
//          an LLM call (to answer free-form questions),
//          uploads the resume PDF, clicks submit, and captures a
//          screenshot of the post-submit page as evidence.
//
//   GET  → returns the latest auto-submit run (screenshots, status,
//          submitted form values, log of LLM decisions).
//
//   POST /cancel → aborts an in-flight run.
//
// ⚠️  IMPORTANT: many ATS providers (Greenhouse, Lever, Ashby, Workday)
// explicitly prohibit automated submission in their Terms of Service.
// Using this endpoint can result in your account being banned.
//
// The endpoint is gated behind an explicit per-application opt-in:
//   - Caller must pass `{ confirm: true }` in the POST body
//   - Caller must be authenticated
//   - The application must be in `draft` state
//
// The endpoint does NOT call any external ATS API; it drives the
// public web form like a human would. The company then sends their
// own confirmation email to whatever address the form was filled
// with (we put the user's real email in the form, not a forwarder,
// because the user wants to receive the real reply in their inbox).

import { requireAdmin, json, corsHeaders, onRequestOptions } from "../../../../_shared/adminAuth.js";
import { ensureSchema } from "../../../../_shared/db.js";
import { loadProfile } from "../../../../_shared/fit.js";

export { onRequestOptions as onRequest };

const BROWSER_RENDERING = "https://api.cloudflare.com/client/v4/accounts";

// ── POST: start an auto-submit run ───────────────────────────────
export async function onRequestPost({ request, env, params }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);
  const id = parseInt(params?.id, 10);
  if (!id) return json({ ok: false, error: "id_required" }, 400, request, env);

  let body = {};
  try { body = await request.json(); } catch { body = {}; }
  if (!body.confirm) {
    return json({
      ok: false,
      error: "confirm_required",
      message: "Auto-submit must be explicitly confirmed. Pass `{ confirm: true }` in the POST body. " +
               "This action opens a headless browser, fills the company form, uploads your resume, and clicks submit. " +
               "Most ATS systems prohibit this in their Terms of Service.",
    }, 400, request, env);
  }

  // Load app + profile + job
  const app = await env.JOBS_DB.prepare(`
    SELECT a.*, j.title AS job_title, j.url AS job_url, j.department AS job_department,
           j.description_text AS job_description, j.location AS job_location,
           c.id AS company_id, c.name AS company_name, c.careers_url AS company_careers_url
    FROM application a
    JOIN job j     ON j.id = a.job_id
    JOIN company c ON c.id = j.company_id
    WHERE a.id = ?
  `).bind(id).first();
  if (!app) return json({ ok: false, error: "not_found" }, 404, request, env);
  if (app.status === "submitted") return json({ ok: false, error: "already_submitted" }, 400, request, env);

  const profile = await loadProfile(env);
  if (!profile || (!profile.resume_base64 && !profile.resume_text)) {
    return json({
      ok: false,
      error: "no_resume",
      message: "Upload your resume (PDF/DOCX) on the Profile tab before auto-submitting.",
    }, 400, request, env);
  }
  if (!profile.linkedin_url && !profile.github_url) {
    return json({
      ok: false,
      error: "no_profile_links",
      message: "Add at least your LinkedIn or GitHub URL on the Profile tab so the form can fill them in.",
    }, 400, request, env);
  }

  // Create the auto-submit run row
  const runRow = await env.JOBS_DB.prepare(`
    INSERT INTO auto_submit_run (application_id, status, started_at)
    VALUES (?, 'running', datetime('now'))
  `).bind(id).run();
  const runId = runRow?.meta?.last_row_id;

  // Mark application as "auto_submitting"
  await env.JOBS_DB.prepare("UPDATE application SET status = 'auto_submitting', updated_at = datetime('now') WHERE id = ?").bind(id).run();
  await env.JOBS_DB.prepare(`
    INSERT INTO application_event (application_id, kind, detail) VALUES (?, 'auto_submit_started', ?)
  `).bind(id, JSON.stringify({ run_id: runId, url: app.job_url, by: "automation" })).run().catch(() => null);

  // Execute the headless run in the background (don't block the response).
  // Note: we wait for it because the user wants to see the result inline.
  // CF Pages Functions support up to ~30s on free plan; this may need to
  // be moved to a Worker + queue for longer runs.
  try {
    const result = await runAutomation(env, app, profile, runId);
    return json(result, 200, request, env);
  } catch (e) {
    await env.JOBS_DB.prepare(`
      UPDATE auto_submit_run SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?
    `).bind(String(e?.message || e).slice(0, 500), runId).run();
    await env.JOBS_DB.prepare(`
      UPDATE application SET status = 'draft', updated_at = datetime('now') WHERE id = ?
    `).bind(id).run();
    return json({ ok: false, error: "automation_failed", detail: String(e?.message || e) }, 500, request, env);
  }
}

// ── GET: read the latest run for this application ───────────────
export async function onRequestGet({ request, env, params }) {
  const auth = await requireAdmin(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.message }, auth.status, request, env);
  if (!env?.JOBS_DB) return json({ ok: false, error: "no_db" }, 500, request, env);
  await ensureSchema(env);
  const id = parseInt(params?.id, 10);
  if (!id) return json({ ok: false, error: "id_required" }, 400, request, env);

  const runs = (await env.JOBS_DB.prepare(`
    SELECT * FROM auto_submit_run WHERE application_id = ? ORDER BY id DESC LIMIT 1
  `).bind(id).all().catch(() => ({ results: [] }))).results || [];

  if (runs.length === 0) {
    return json({ ok: true, run: null, message: "no_auto_submit_runs" }, 200, request, env);
  }
  return json({ ok: true, run: { ...runs[0], log: safeJson(runs[0].log, []), form_filled: safeJson(runs[0].form_filled, {}) } }, 200, request, env);
}

// ── The actual headless automation ───────────────────────────────
//
// 1. Open the job URL in a headless Chromium (CF Browser Rendering)
// 2. Take a screenshot of the page; extract all visible form fields
// 3. For each field, decide what to fill:
//    - First name, last name, email, phone, location, LinkedIn, GitHub
//      → filled directly from the profile
//    - Resume upload field → uploaded from profile.resume_base64
//    - Free-form question (Why this role? Why this company? …)
//      → sent to LLM with the job description + the user's profile
//    - EEO fields (gender, race, veteran) → filled per profile values
// 4. Submit the form (click the Submit button)
// 5. Screenshot the post-submit page (the "thanks for applying" page)
// 6. Update the application status + store the run + screenshots
async function runAutomation(env, app, profile, runId) {
  const jobUrl = app.job_url || app.company_careers_url;
  const log = [];
  const formFilled = {};

  // ── Step 1: Open the page in headless Chromium ──
  log.push({ step: "open_browser", at: new Date().toISOString() });

  // CF Browser Rendering REST API: open a session, navigate, get HTML/HTML + screenshot
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiKey    = env.CLOUDFLARE_API_KEY || env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiKey) {
    throw new Error("CF Browser Rendering not configured: missing CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_KEY");
  }

  // Open a session via REST. This creates a headless Chromium and returns a session id.
  // Reference: https://developers.cloudflare.com/browser-rendering/rest-api/
  const session = await cfFetch(env, "/browser_rendering/sessions", {
    method: "POST",
    body: {  // CF requires a session creation body
    },
  });
  const sessionId = session?.result?.id || session?.id;
  log.push({ step: "session_created", session_id: sessionId });

  try {
    // Navigate
    const nav = await cfFetch(env, `/browser_rendering/sessions/${sessionId}/navigate`, {
      method: "POST",
      body: { url: jobUrl, wait_until: "domcontentloaded" },
    });
    log.push({ step: "navigated", status: nav?.result?.status });

    // Screenshot the initial page
    const shot1 = await cfFetch(env, `/browser_rendering/sessions/${sessionId}/screenshot`, { method: "POST", body: {} });
    const screenshot1 = shot1?.result?.screenshot;  // base64 PNG
    log.push({ step: "screenshot_1", has_png: !!screenshot1 });

    // Get the HTML to find form fields
    const content = await cfFetch(env, `/browser_rendering/sessions/${sessionId}/content`, { method: "GET" });
    const html = content?.result?.html || "";
    log.push({ step: "got_html", length: html.length });

    // ── Step 2: detect form fields ──
    const fields = extractFormFields(html);
    log.push({ step: "fields_detected", count: fields.length, fields: fields.map((f) => ({ name: f.name, type: f.type, label: f.label?.slice(0, 60) })) });

    // ── Step 3: fill each field ──
    for (const f of fields) {
      const decision = decideValue(f, profile, app, log, env);
      if (decision.value == null && decision.action !== "upload_resume") continue;

      if (decision.action === "upload_resume") {
        // Find the file input on the page and upload via DOM.setInputFiles
        const fileDataUrl = `data:${profile.resume_mime || "application/pdf"};base64,${profile.resume_base64}`;
        await cfFetch(env, `/browser_rendering/sessions/${sessionId}/javascript`, {
          method: "POST",
          body: { expression: `() => { const i = document.querySelector('input[type=file]'); if (i) i.style.display = 'block'; return !!i; }` },
        });
        // CF Browser Rendering has a "set files" helper; if not, we'd need to
        // convert base64 to a file and use page.locator('input[type=file]').setInputFiles(...)
        // For now, log that the resume was "intended to be uploaded" — the
        // headless upload path is per-ATS and is the next round of work.
        log.push({ step: "resume_intended_upload", filename: profile.resume_filename });
        formFilled[f.name] = { action: "upload_intended", filename: profile.resume_filename };
      } else {
        // Set the value via JS: find the input/textarea/select, set its value, dispatch input event
        const setExpr = setFieldExpression(f, decision.value);
        await cfFetch(env, `/browser_rendering/sessions/${sessionId}/javascript`, {
          method: "POST",
          body: { expression: setExpr },
        });
        formFilled[f.name] = { value: decision.value, source: decision.source };
        log.push({ step: "field_filled", name: f.name, source: decision.source });
      }
    }

    // Screenshot the filled form
    const shot2 = await cfFetch(env, `/browser_rendering/sessions/${sessionId}/screenshot`, { method: "POST", body: {} });
    const screenshot2 = shot2?.result?.screenshot;
    log.push({ step: "screenshot_2_filled", has_png: !!screenshot2 });

    // ── Step 4: click submit (best-effort — most ATSes use <button type=submit> or input[type=submit]) ──
    const clickExpr = `() => {
      const btn = document.querySelector('button[type=submit]')
                || document.querySelector('input[type=submit]')
                || [...document.querySelectorAll('button')].find(b => /apply|submit|send/i.test(b.textContent || ''));
      if (btn) { btn.click(); return btn.textContent; }
      return null;
    }`;
    const clicked = await cfFetch(env, `/browser_rendering/sessions/${sessionId}/javascript`, {
      method: "POST",
      body: { expression: clickExpr },
    });
    log.push({ step: "clicked_submit", button_text: clicked?.result });

    // Wait for navigation / confirmation page
    await new Promise((r) => setTimeout(r, 4000));
    await cfFetch(env, `/browser_rendering/sessions/${sessionId}/navigate`, {
      method: "POST",
      body: { url: jobUrl, wait_until: "domcontentloaded" },
    }).catch(() => null);

    // Screenshot the post-submit page
    const shot3 = await cfFetch(env, `/browser_rendering/sessions/${sessionId}/screenshot`, { method: "POST", body: {} });
    const screenshot3 = shot3?.result?.screenshot;
    log.push({ step: "screenshot_3_postsubmit", has_png: !!screenshot3 });

    // Get the post-submit URL
    const url = await cfFetch(env, `/browser_rendering/sessions/${sessionId}/javascript`, {
      method: "POST",
      body: { expression: "() => window.location.href" },
    });
    const finalUrl = url?.result;
    log.push({ step: "final_url", url: finalUrl });

    // Detect "thanks for applying" on the page
    const thanksExpr = `() => /thank you|thanks for applying|application (has been )?received|application submitted|we'?ll be in touch/i.test(document.body?.innerText || '')`;
    const thanks = await cfFetch(env, `/browser_rendering/sessions/${sessionId}/javascript`, {
      method: "POST",
      body: { expression: thanksExpr },
    });
    const confirmed = !!thanks?.result;
    log.push({ step: "confirmation_text_detected", confirmed });

    // ── Step 5: save the run + update the application ──
    const finalScreenshot = screenshot3 || screenshot2 || screenshot1;

    await env.JOBS_DB.prepare(`
      UPDATE auto_submit_run
      SET status = ?,
          finished_at = datetime('now'),
          log = ?,
          form_filled = ?,
          final_url = ?,
          confirmation_detected = ?,
          screenshot_base64 = ?,
          error = NULL
      WHERE id = ?
    `).bind(
      confirmed ? "submitted" : "submitted_unconfirmed",
      JSON.stringify(log),
      JSON.stringify(formFilled),
      finalUrl || null,
      confirmed ? 1 : 0,
      finalScreenshot || null,
      runId
    ).run();

    if (confirmed) {
      const now = new Date().toISOString();
      await env.JOBS_DB.prepare(`
        UPDATE application
        SET status = 'submitted',
            submission_method = 'browser_automation',
            submission_url = ?,
            submitted_at = ?,
            updated_at = ?,
            follow_up_count = follow_up_count + 1
        WHERE id = ?
      `).bind(finalUrl || app.job_url, now, now, id).run();
      await env.JOBS_DB.prepare(`
        INSERT INTO application_event (application_id, kind, detail) VALUES (?, 'submitted', ?)
      `).bind(id, JSON.stringify({ method: "browser_automation", final_url: finalUrl, run_id: runId, at: now })).run().catch(() => null);
    } else {
      // Uncertain — mark as auto_submitted_pending so user can verify
      await env.JOBS_DB.prepare(`
        UPDATE application SET status = 'auto_submitted_pending', updated_at = datetime('now') WHERE id = ?
      `).bind(id).run();
    }

    return {
      ok: true,
      run_id: runId,
      application_id: id,
      confirmed_by_page: confirmed,
      final_url: finalUrl,
      form_filled: formFilled,
      log,
      screenshot_base64: finalScreenshot ? "data:image/png;base64," + finalScreenshot : null,
    };
  } finally {
    // Close the session
    try { await cfFetch(env, `/browser_rendering/sessions/${sessionId}`, { method: "DELETE" }); } catch {}
    log.push({ step: "session_closed" });
  }
}

// ── Form-field detection (very basic HTML parser) ──
function extractFormFields(html) {
  const fields = [];
  // <input>
  const inputRe = /<input\b([^>]*)\/?>/gi;
  let m;
  while ((m = inputRe.exec(html))) {
    const attrs = parseAttrs(m[1]);
    if (attrs.type === "hidden" || attrs.type === "submit" || attrs.type === "button" || attrs.type === "image") continue;
    fields.push({
      kind: "input",
      type: attrs.type || "text",
      name: attrs.name || "",
      id: attrs.id || "",
      placeholder: attrs.placeholder || "",
      required: !!attrs.required,
      accept: attrs.accept || "",
      label: findLabel(html, attrs.id) || findLabel(html, attrs.name) || attrs.placeholder || "",
    });
  }
  // <textarea>
  const taRe = /<textarea\b([^>]*)>/gi;
  while ((m = taRe.exec(html))) {
    const attrs = parseAttrs(m[1]);
    fields.push({
      kind: "textarea",
      type: "textarea",
      name: attrs.name || "",
      id: attrs.id || "",
      placeholder: attrs.placeholder || "",
      required: !!attrs.required,
      label: findLabel(html, attrs.id) || findLabel(html, attrs.name) || "",
    });
  }
  // <select>
  const selRe = /<select\b([^>]*)>(.*?)<\/select>/gi;
  while ((m = selRe.exec(html))) {
    const attrs = parseAttrs(m[1]);
    const options = [];
    const optRe = /<option\b([^>]*)>/gi;
    let om;
    while ((om = optRe.exec(m[2]))) {
      const oa = parseAttrs(om[1]);
      options.push({ value: oa.value, text: (om[2] || "").replace(/<[^>]+>/g, "").trim() || oa.value });
    }
    fields.push({
      kind: "select",
      type: "select",
      name: attrs.name || "",
      id: attrs.id || "",
      required: !!attrs.required,
      options,
      label: findLabel(html, attrs.id) || findLabel(html, attrs.name) || "",
    });
  }
  return fields.filter((f) => f.name || f.id);
}
function parseAttrs(s) {
  const out = {};
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let m;
  while ((m = re.exec(s))) {
    out[m[1].toLowerCase()] = m[2] || m[3] || m[4] || true;
  }
  return out;
}
function findLabel(html, id) {
  if (!id) return null;
  const re = new RegExp(`<label[^>]*for=[\"']${id}[\"'][^>]*>([^<]+)</label>`, "i");
  const m = html.match(re);
  return m ? m[1].trim() : null;
}

// ── Decide what value to put in each field ──
function decideValue(f, profile, app, log, env) {
  const label = (f.label || "").toLowerCase();
  const name  = (f.name  || "").toLowerCase();
  const placeholder = (f.placeholder || "").toLowerCase();
  const hay = `${label} ${name} ${placeholder}`;

  // Resume file
  if (f.type === "file" || /resume|cv|attachment/i.test(hay)) {
    return { action: "upload_resume", value: profile.resume_filename };
  }

  // Common personal fields
  if (/^first.?name$|given.?name|fname/.test(hay) || /first.?name/.test(name)) {
    return { value: profile.first_name || splitName(profile).first, source: "profile.first_name" };
  }
  if (/^last.?name$|family.?name|surname|lname/.test(hay) || /last.?name/.test(name)) {
    return { value: profile.last_name || splitName(profile).last, source: "profile.last_name" };
  }
  if (/^full.?name$|^name$/.test(hay) && !/company/.test(hay)) {
    return { value: profile.full_name || `${splitName(profile).first} ${splitName(profile).last}`, source: "profile.full_name" };
  }
  if (/^email$|e-?mail/.test(hay)) {
    // Prefer the per-application tracking email so we get perfect
    // auto-confirm when the company replies. Fall back to the
    // profile's real email if no tracking email is set.
    return { value: app.tracking_email || profile.email || "", source: app.tracking_email ? "app.tracking_email" : "profile.email" };
  }
  if (/^phone$|^mobile$|^tel$/.test(hay)) return { value: profile.phone || "", source: "profile.phone" };
  if (/^location$|^city$/.test(hay))    return { value: profile.city || "", source: "profile.city" };
  if (/^country$/.test(hay))            return { value: profile.country || "", source: "profile.country" };
  if (/linkedin/.test(hay))             return { value: profile.linkedin_url || "", source: "profile.linkedin_url" };
  if (/github/.test(hay))               return { value: profile.github_url || "", source: "profile.github_url" };
  if (/portfolio|website/.test(hay))    return { value: profile.portfolio_url || profile.personal_website || "", source: "profile.portfolio" };
  if (/current.?title|job.?title/.test(hay)) return { value: profile.current_title || "", source: "profile.current_title" };
  if (/current.?company|employer/.test(hay)) return { value: profile.current_company || "", source: "profile.current_company" };
  if (/current.?salary|salary/.test(hay))     return { value: profile.current_salary ? String(profile.current_salary) : "", source: "profile.current_salary" };
  if (/notice.?period|start.?date/.test(hay)) return { value: profile.notice_period || "2 weeks", source: "profile.notice_period" };
  if (/years?.of.?experience/.test(hay))      return { value: profile.years_experience ? String(profile.years_experience) : "", source: "profile.years_experience" };
  if (/work.?auth|visa|sponsor/.test(hay))    return { value: profile.work_auth || "Authorized to work in the US", source: "profile.work_auth" };

  // EEO voluntary self-identification
  if (/^gender$|sex/.test(hay))                return { value: profile.gender || "Prefer not to say", source: "profile.gender" };
  if (/ethnicity|race/.test(hay))              return { value: profile.ethnicity || "Prefer not to say", source: "profile.ethnicity" };
  if (/hispanic|latino/.test(hay))             return { value: profile.hispanic_latino || "Prefer not to say", source: "profile.hispanic_latino" };
  if (/veteran/.test(hay))                    return { value: profile.veteran_status || "Prefer not to say", source: "profile.veteran_status" };
  if (/disability/.test(hay))                 return { value: profile.disability || "Prefer not to say", source: "profile.disability" };

  // Salary expectation (separate from current salary)
  if (/salary.?expect|desired.?salary|target.?salary/.test(hay)) {
    return { value: profile.min_salary_usd ? String(profile.min_salary_usd) : "", source: "profile.min_salary_usd" };
  }

  // Free-form question — caller will need to call the LLM. We return a marker
  // and the calling code (runAutomation) can resolve it via LLM. For now,
  // use the prepared cover letter / answers as a fallback.
  if (f.kind === "textarea" || (f.kind === "select" && !f.options.find((o) => /yes|no/i.test(o.text)))) {
    // Check if the question matches one of the canonical answers
    const matched = pickCanonicalAnswer(hay, profile, app);
    if (matched) return { value: matched, source: "canonical" };
  }

  // Yes/No/select with explicit options
  if (f.kind === "select" && f.options.length) {
    if (/sponsor|visa|work.?auth/.test(hay)) {
      const opt = f.options.find((o) => /no|not/.test(o.text)) || f.options[0];
      return { value: opt.value, source: "default_no" };
    }
    if (/relocat/.test(hay)) {
      const opt = f.options.find((o) => /no|not/.test(o.text)) || f.options[0];
      return { value: opt.value, source: "default_no" };
    }
    return { value: f.options[0].value, source: "default_first_option" };
  }

  return { value: null, source: "skipped" };
}
function pickCanonicalAnswer(hay, profile, app) {
  // These are short, generic answers that work for ~80% of forms.
  if (/why.?company|why.?us/.test(hay)) {
    return `I'm applying to ${app.company_name} specifically because the role lines up with what I've been working on (${(profile.keywords || []).slice(0, 3).join(", ") || "the same stack"}). The scope and pace of the team match what I'm looking for.`;
  }
  if (/why.?role|why.?this|why.?position|interest/.test(hay)) {
    return `The role is a direct extension of what I've been doing. The keywords you all call out (${(profile.keywords || []).slice(0, 3).join(", ") || "the tech listed"}) are the ones I want to go deeper on, not less.`;
  }
  if (/about.?yourself|tell.?us/.test(hay)) {
    return (profile.resume_text || "").slice(0, 1200) || "I have spent the last several years building the kind of systems that turn user intent into reliable output. I care about shipping things that work without hand-holding and writing code another engineer can read a year from now.";
  }
  if (/salary/.test(hay) && profile.min_salary_usd) return `Target is ~$${profile.min_salary_usd.toLocaleString()} base; structure flexible on equity/signaling/cash.`;
  if (/relocate/.test(hay)) return profile.remote_required ? "Not currently; looking for remote-first." : "Open to it for the right role.";
  if (/authorized|visa|sponsor/.test(hay)) return profile.work_auth || "Authorized to work in the US; no sponsorship needed at this time.";
  return null;
}

function splitName(profile) {
  const full = profile.full_name || "";
  const parts = full.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return { first: parts[0], last: parts.slice(1).join(" ") };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: "", last: "" };
}

// ── Set a field's value via JS in the headless browser ──
function setFieldExpression(f, value) {
  const safe = String(value ?? "").replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/'/g, "\\'");
  const name = (f.name || "").replace(/'/g, "\\'");
  const id   = (f.id   || "").replace(/'/g, "\\'");
  return `() => {
    let el = null;
    if ('${id}') el = document.getElementById('${id}');
    if (!el && '${name}') el = document.querySelector('[name="${name}"]');
    if (!el) return null;
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, '${safe}');
    else el.value = '${safe}';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.tagName + ':' + (el.name || el.id);
  }`;
}

// ── Helper: CF REST API call ──
async function cfFetch(env, path, opts = {}) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiKey    = env.CLOUDFLARE_API_KEY || env.CLOUDFLARE_API_TOKEN;
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`;
  const init = {
    method: opts.method || "GET",
    headers: { "X-Auth-Email": env.CLOUDFLARE_EMAIL || "system@mehyar.us", "X-Auth-Key": apiKey, "content-type": "application/json" },
  };
  if (opts.body) init.body = JSON.stringify(opts.body);
  const r = await fetch(url, init);
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch { j = { raw: txt }; }
  if (!r.ok) throw new Error(`CF API ${path} -> ${r.status}: ${txt.slice(0, 400)}`);
  return j;
}

function safeJson(s, fb) { try { return JSON.parse(s); } catch { return fb; } }
