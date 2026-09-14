// GET/POST /pref/<token> — signed preference landing page (Worker 6).
//
// The token is a `pref:` HMAC URL (see signPrefToken/verifyPrefToken in
// _shared/userAuth.js): it identifies the contact by email with no login.
// Tampered or expired tokens are rejected.
//
// GET  renders the preference form (industries, work style, wants, and an
//      unchecked-by-default explicit email-consent checkbox).
// POST saves preferences, graduates the contact (pending -> active, off
//      the legacy/SMTP2GO stream onto the fresh/Brevo stream), and records
//      an email_consent row ONLY when the consent checkbox was checked.

import { ensureSchema } from "../_shared/db.js";
import { verifyPrefToken } from "../_shared/userAuth.js";
import { pageChrome, APP_URL } from "../_shared/seo.js";
import {
  esc, recordLandingClick,
  ensureEmailContact, getContactPreference, parsePreferenceForm,
  savePreferences, graduateContact, buildPreferencePage, notFoundPage,
} from "../_shared/landing.js";

const CT = { "Content-Type": "text/html; charset=utf-8" };

function badRequest(title) {
  return new Response(pageChrome({ title, noindex: true, body: notFoundPage(title) }), { status: 400, headers: CT });
}

export async function onRequestGet({ env, params }) {
  await ensureSchema(env).catch(() => null);
  const db = env?.JOBS_DB;
  const em = await verifyPrefToken(params?.token, env);
  if (!em || !db) return badRequest("This link is invalid or has expired.");
  const contact = await ensureEmailContact(db, em);
  const saved = await getContactPreference(db, contact.id);
  const appUrl = env.JOBS_APP_URL || APP_URL;
  const html = pageChrome({
    title: "Your preferences — mehyar.jobs",
    noindex: true,
    body: buildPreferencePage({ token: String(params.token), email: em, saved, appUrl }),
  });
  return new Response(html, { headers: CT });
}

export async function onRequestPost({ request, env, params }) {
  await ensureSchema(env).catch(() => null);
  const db = env?.JOBS_DB;
  const em = await verifyPrefToken(params?.token, env);
  if (!em || !db) return badRequest("This link is invalid or has expired.");
  let form;
  try {
    form = await request.formData();
  } catch {
    return badRequest("Could not read the form. Please try again.");
  }
  const prefs = parsePreferenceForm(form);
  const contact = await ensureEmailContact(db, em);
  await savePreferences(db, contact.id, prefs);
  await graduateContact(db, contact, { consentGiven: prefs.consentGiven });
  const saved = await getContactPreference(db, contact.id);

  const today = new Date().toISOString().slice(0, 10);
  await recordLandingClick(db, {
    date: today, pageType: "preference", slug: "preference",
    contactId: contact.id, ip: request.headers.get("cf-connecting-ip"),
  });

  const appUrl = env.JOBS_APP_URL || APP_URL;
  const html = pageChrome({
    title: "Preferences saved — mehyar.jobs",
    noindex: true,
    body: buildPreferencePage({ token: String(params.token), email: em, saved, appUrl, savedMsg: true }),
  });
  return new Response(html, { headers: CT });
}
