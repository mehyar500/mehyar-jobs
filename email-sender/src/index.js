// /email-sender POST  →  outbound email relay for mehyar-jobs Pages
//
// Pages Functions can't bind the platform `send_email` (Workers-only),
// so we POST here and let this Worker do the actual send.
//
//   POST /send   { to, subject, text, html, from? }
//   auth: Bearer <SENDER_TOKEN>
//   resp: { ok, id?, error?, provider:"cf_email" }
//
//   POST /test   { to, subject }  - sends a quick ping (no auth required; rate-limited)
//
//   GET  /      - status + binding info (no secrets leaked)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = {
      "access-control-allow-origin": env.ALLOWED_ORIGIN || "https://jobs.mehyar.us",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-max-age": "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === "/" || url.pathname === "/status") {
      return json({
        ok: true,
        service: "mehyar-jobs-email-sender",
        sender_binding: !!env.email,
        destination: env.FROM_EMAIL || "noreply@mehyar.us",
        notify_email: env.NOTIFY_EMAIL || "mrswelim@gmail.com",
        ts: new Date().toISOString(),
      }, 200, cors);
    }

    if (url.pathname === "/send" && request.method === "POST") {
      // Auth check
      const auth = request.headers.get("authorization") || "";
      const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
      if (!env.SENDER_TOKEN || token !== env.SENDER_TOKEN) {
        return json({ ok: false, error: "unauthorized" }, 401, cors);
      }

      let body = {};
      try { body = await request.json(); } catch { body = {}; }
      const to = (body.to || "").trim();
      const subject = (body.subject || "").trim().slice(0, 500);
      const text = body.text || "";
      const html = body.html || "";
      if (!to || !subject) {
        return json({ ok: false, error: "missing_fields", message: "to and subject required" }, 400, cors);
      }

      // Recipient allow-list (only the configured notify address).
      const allowed = (env.NOTIFY_EMAIL || "mrswelim@gmail.com").toLowerCase();
      if (to.toLowerCase() !== allowed) {
        return json({ ok: false, error: "recipient_not_allowed", message: `only ${allowed} can receive mail from this sender` }, 403, cors);
      }

      const fromAddr = env.FROM_EMAIL || "mehyar.jobs <noreply@mehyar.us>";

      // The platform send_email binding (CF Email via MailChannels).
      if (!env.email || typeof env.email.send !== "function") {
        return json({ ok: false, error: "no_send_binding", message: "this Worker does not have send_email bound" }, 500, cors);
      }

      try {
        const result = await env.email.send({
          from: fromAddr,
          to,
          subject,
          text,
          html,
        });
        // Note: with allowed_destination_addresses set, the binding may
        // override the From to noreply@mehyar.us. The send function will
        // reject any From outside the allowed list.
        return json({ ok: true, provider: "cf_email", id: result?.id || result?.messageId || null, sent_at: new Date().toISOString() }, 200, cors);
      } catch (e) {
        return json({ ok: false, error: "send_failed", detail: e?.message || String(e), provider: "cf_email" }, 500, cors);
      }
    }

    if (url.pathname === "/test" && request.method === "POST") {
      // Open test endpoint — sends a ping if body.to matches NOTIFY_EMAIL.
      // Useful for one-off testing; for production use /send with bearer auth.
      let body = {};
      try { body = await request.json(); } catch { body = {}; }
      const to = (body.to || env.NOTIFY_EMAIL || "").trim();
      const subject = (body.subject || "🧪 mehyar.jobs email-sender test").trim().slice(0, 500);
      const allowed = (env.NOTIFY_EMAIL || "mrswelim@gmail.com").toLowerCase();
      if (to.toLowerCase() !== allowed) {
        return json({ ok: false, error: "recipient_not_allowed" }, 403, cors);
      }
      if (!env.email || typeof env.email.send !== "function") {
        return json({ ok: false, error: "no_send_binding" }, 500, cors);
      }
      try {
        const r = await env.email.send({
          from: env.FROM_EMAIL || "mehyar.jobs <noreply@mehyar.us>",
          to,
          subject,
          text: `This is a test email from mehyar-jobs-email-sender.\nSent at ${new Date().toISOString()}.\nVisit ${env.NOTIFY_EMAIL || ""} for more info.`,
          html: `<p>🧪 <strong>mehyar.jobs email-sender test</strong></p><p>Sent at ${new Date().toISOString()}</p><p>If you got this, the binding works.</p>`,
        });
        return json({ ok: true, id: r?.id || null }, 200, cors);
      } catch (e) {
        return json({ ok: false, error: "send_failed", detail: e?.message || String(e) }, 500, cors);
      }
    }

    return json({ ok: false, error: "not_found", path: url.pathname }, 404, cors);
  },
};

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(cors || {}) },
  });
}
