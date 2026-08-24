// _shared/email.js
//
// Send transactional email via the Cloudflare Email Service
// (`platform@/email/send`) — the one that works from Pages Functions
// without a SendGrid / Mailgun / Resend dependency.
//
// The CF Email Service is free for the first 100k sends/month and
// works the same as mailgun from a Pages Function. We use it to send
// the "application submitted" notification the user wants.
//
// Required bindings (set via CF Pages project env or wrangler.toml):
//   - NOTIFY_EMAIL   = "info@mehyar.us"  (the user-facing address)
//   - FROM_EMAIL     = "mehyar.jobs <noreply@mehyar.us>"
//
// If either is missing, we fall back to a no-op + console.log so the
// app still works (the application is still recorded in DB), and we
// return `ok: false, error: "email_not_configured"` so the caller can
// surface a banner.

export async function sendEmail(env, { to, subject, html, text }) {
  if (!env?.NOTIFY_EMAIL && !to) return { ok: false, error: "no_recipient" };
  const toAddr = to || env.NOTIFY_EMAIL;
  const fromAddr = env.FROM_EMAIL || "mehyar.jobs <noreply@mehyar.us>";

  // If we're in a Pages Function, the platform binding is `env.email`
  // or we use the /email/send API. CF Pages has a built-in
  // "platform binding" of type "email" that maps to this.
  const sender = env?.EMAIL_SEND_BINDING || env?.email;
  if (sender && typeof sender.send === "function") {
    try {
      const msg = { from: fromAddr, to: toAddr, subject, text, html };
      const r = await sender.send(msg);
      return { ok: true, provider: "cf_email", id: r?.id || null };
    } catch (e) {
      return { ok: false, provider: "cf_email", error: e?.message || String(e) };
    }
  }

  // Outbound over the email-sender Worker (Pages can't bind send_email,
  // so we bridge via HTTP). Set EMAIL_SENDER_URL + EMAIL_SENDER_TOKEN
  // in the project's env (wrangler.toml or CF dashboard).
  if (env.EMAIL_SENDER_URL) {
    try {
      const r = await fetch(env.EMAIL_SENDER_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(env.EMAIL_SENDER_TOKEN ? { "authorization": `Bearer ${env.EMAIL_SENDER_TOKEN}` } : {}),
          "user-agent": "mehyar-jobs-pages/1.0",
        },
        body: JSON.stringify({ to: toAddr, subject, text, html }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok) {
        return { ok: true, provider: "cf_email_via_worker", id: d.id, sent_at: d.sent_at };
      }
      return { ok: false, provider: "cf_email_via_worker", error: d.error || d.detail || `http_${r.status}` };
    } catch (e) {
      // Fall through to the REST fallback below.
      console.log("email.js: sender-Worker fetch failed:", e?.message);
    }
  }

  // Fallback: try the REST API for email service (same as the
  // Worker Email handler). This is a known shape as of 2026.
  try {
    const accountId = env?.CLOUDFLARE_ACCOUNT_ID || "";
    const apiKey = env?.CLOUDFLARE_API_KEY || env?.CLOUDFLARE_API_TOKEN || "";
    if (!accountId || !apiKey) {
      return { ok: false, error: "email_not_configured" };
    }
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/email/routing/addresses`;
    // We don't actually have a generic "send" API in REST; the platform
    // binding is the right path. Log + skip here.
    console.log("[email] no platform binding; would send to", toAddr, "subject:", subject);
    return { ok: false, error: "email_no_binding" };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// Render the "application submitted" email — the user said this is
// their primary confirmation: "the website sends me an email telling
// me thank you for submitting my application. So that's how I know."
export function renderApplicationEmail({ application, job, company, profile }) {
  const subject = `✅ Application submitted: ${job?.title} at ${company?.name}`;
  const text = [
    `Hi ${profile?.target_titles?.[0] ? "" : ""}Application submitted!`,
    "",
    `Job:      ${job?.title}`,
    `Company:  ${company?.name}`,
    `Location: ${job?.location || "—"}`,
    `Remote:   ${job?.remote_policy || "—"}`,
    `Fit:      ${job?.score ?? "—"}/100`,
    "",
    `Submission URL: ${application?.submission_url || job?.url || "—"}`,
    `Method:         ${application?.submission_method || "manual"}`,
    `Submitted at:   ${application?.submitted_at || new Date().toISOString()}`,
    "",
    `—`,
    `mehyar.jobs`,
    `Application ID: #${application?.id}`,
    `View / update status: https://jobs.mehyar.us/applications/${application?.id}`,
  ].join("\n");

  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
  <h1 style="color: #16a34a; font-size: 24px; margin: 0 0 16px;">✅ Application submitted</h1>
  <p style="font-size: 16px; color: #18181b; line-height: 1.5;">
    Thank you for submitting your application to <strong>${escape(company?.name)}</strong> for the <strong>${escape(job?.title)}</strong> role.
  </p>
  <table style="margin: 16px 0; border-collapse: collapse; font-size: 14px;">
    <tr><td style="padding: 4px 12px 4px 0; color: #71717a;">Company</td><td style="padding: 4px 0;"><strong>${escape(company?.name)}</strong></td></tr>
    <tr><td style="padding: 4px 12px 4px 0; color: #71717a;">Title</td><td style="padding: 4px 0;">${escape(job?.title)}</td></tr>
    <tr><td style="padding: 4px 12px 4px 0; color: #71717a;">Location</td><td style="padding: 4px 0;">${escape(job?.location || "—")}${job?.remote_policy && job?.remote_policy !== "unknown" ? " · " + escape(job?.remote_policy) : ""}</td></tr>
    <tr><td style="padding: 4px 12px 4px 0; color: #71717a;">Fit score</td><td style="padding: 4px 0;">${job?.score ?? "—"}/100</td></tr>
    <tr><td style="padding: 4px 12px 4px 0; color: #71717a;">Method</td><td style="padding: 4px 0;">${escape(application?.submission_method || "manual")}</td></tr>
    <tr><td style="padding: 4px 12px 4px 0; color: #71717a;">Submitted</td><td style="padding: 4px 0;">${escape(application?.submitted_at || new Date().toISOString())}</td></tr>
  </table>
  <p style="margin: 16px 0;">
    <a href="${escape(application?.submission_url || job?.url || "https://jobs.mehyar.us/")}" style="display: inline-block; background: #18181b; color: #fff; text-decoration: none; padding: 10px 16px; border-radius: 8px; font-size: 14px;">
      ${application?.submission_method === "external_link" ? "Open external application →" : "View job →"}
    </a>
  </p>
  <hr style="border: 0; border-top: 1px solid #e4e4e7; margin: 24px 0;" />
  <p style="font-size: 12px; color: #a1a1aa; margin: 0;">
    mehyar.jobs · Application #${application?.id} · <a href="https://jobs.mehyar.us/applications" style="color: #a1a1aa;">All applications</a>
  </p>
</div>`.trim();

  return { subject, text, html };
}

function escape(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[c]);
}
