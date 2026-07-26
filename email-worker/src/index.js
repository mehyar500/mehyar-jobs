// CF Email Worker — runs on every incoming email to jobs.mehyar.us,
// parses the MIME message, extracts (from, to, subject, body, headers),
// and POSTs the structured payload to the /api/email/inbound endpoint
// of the mehyar-jobs Pages Function. That endpoint matches the email
// to the right application and marks it as company_confirmed.
//
// Deployed as a separate Worker (not a Pages Function) because email
// handlers in Cloudflare must be a Worker, not a Pages Function.
//
// Bindings (set in wrangler.toml or via `wrangler secret put`):
//   - MEHYAR_JOBS_WEBHOOK  = "https://jobs.mehyar.us/api/email/inbound"
//   - MEHYAR_JOBS_TOKEN    = the same HMAC JWT the user has (admin
//                            scope) — used to auth the webhook call
//
// Routes (set in CF Email Routing or in wrangler.toml):
//   - "app-*@jobs.mehyar.us"   → this worker
//
// Source: https://developers.cloudflare.com/email-routing/email-workers/

export default {
  async email(message, env, ctx) {
    const from = message.from;
    const to = message.to;
    const subject = message.headers.get("subject") || "";
    const messageId = message.headers.get("message-id") || "";
    const date = message.headers.get("date") || new Date().toISOString();

    // Parse the MIME body
    let text = "";
    let html = "";
    const headers = {};
    for (const [k, v] of message.headers.entries()) {
      headers[k.toLowerCase()] = v;
    }

    try {
      const reader = message.body.getReader();
      const decoder = new TextDecoder();
      let raw = "";
      // Stream the body — emails can be large
      let done = false;
      while (!done) {
        const { value, done: d } = await reader.read();
        if (value) raw += decoder.decode(value, { stream: true });
        done = d;
      }
      raw += decoder.decode();
      const parsed = parseMime(raw);
      text = parsed.text;
      html = parsed.html;
    } catch (e) {
      console.log("email-worker: MIME parse failed:", e?.message);
    }

    // Forward to the Pages Function
    const url = env.MEHYAR_JOBS_WEBHOOK || "https://jobs.mehyar.us/api/email/inbound";
    const token = env.MEHYAR_JOBS_TOKEN || "";

    try {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": token ? `Bearer ${token}` : "",
        },
        body: JSON.stringify({
          from,
          to,
          subject,
          message_id: messageId,
          date,
          text: text.slice(0, 50_000),
          html: html.slice(0, 200_000),
          headers,
        }),
      });
      console.log(`email-worker: POST ${url} -> ${r.status}`);
    } catch (e) {
      console.log("email-worker: POST failed:", e?.message);
      // Re-throw so CF knows the worker failed and will retry
      throw e;
    }
  },
};

// ── Simple MIME parser ──
// Handles text/plain + text/html. Strips quoted-printable + base64.
// For multipart, walks parts and picks out the text parts.
function parseMime(raw) {
  const result = { text: "", html: "" };
  if (!raw) return result;

  // Detect multipart
  const ctMatch = /Content-Type:\s*([^\r\n;]+)(?:;\s*boundary=("[^"]+"|[^\s;]+))?/i.exec(raw);
  const topType = (ctMatch?.[1] || "").trim().toLowerCase();

  if (topType === "text/plain") {
    result.text = decodeBody(raw, ctMatch?.[2] || null);
    return result;
  }
  if (topType === "text/html") {
    result.html = decodeBody(raw, ctMatch?.[2] || null);
    return result;
  }

  // Multipart
  const boundary = (ctMatch?.[2] || "").replace(/^"|"$/g, "");
  if (!boundary) {
    // Try to detect boundary elsewhere in headers
    const bm = /boundary=("[^"]+"|[^\s;]+)/i.exec(raw);
    if (bm) {
      // Re-parse with boundary
      return parseMime(`Content-Type: multipart/alternative; boundary=${bm[1]}\r\n\r\n${raw.split(/\r?\n\r?\n/).slice(1).join("\r\n\r\n")}`);
    }
    return result;
  }
  const parts = splitByBoundary(raw, boundary);
  for (const part of parts) {
    const sub = parseMime(part);
    if (sub.text && !result.text) result.text = sub.text;
    if (sub.html && !result.html) result.html = sub.html;
  }
  return result;
}

function splitByBoundary(raw, boundary) {
  const delim = "--" + boundary;
  const endDelim = "--" + boundary + "--";
  const lines = raw.split(/\r?\n/);
  const parts = [];
  let current = [];
  let inPart = false;
  for (const line of lines) {
    if (line === delim) {
      if (inPart) parts.push(current.join("\n"));
      current = [];
      inPart = true;
    } else if (line === endDelim) {
      if (inPart) parts.push(current.join("\n"));
      current = [];
      inPart = false;
    } else if (inPart) {
      current.push(line);
    }
  }
  if (inPart && current.length) parts.push(current.join("\n"));
  return parts.filter((p) => p.trim().length > 0);
}

function decodeBody(part, boundary) {
  // Look for Content-Transfer-Encoding
  const cteMatch = /Content-Transfer-Encoding:\s*([^\r\n]+)/i.exec(part);
  const cte = (cteMatch?.[1] || "").trim().toLowerCase();

  // Strip headers — body is after the first blank line
  const bodyStart = part.indexOf("\r\n\r\n") !== -1
    ? part.indexOf("\r\n\r\n") + 4
    : (part.indexOf("\n\n") !== -1 ? part.indexOf("\n\n") + 2 : 0);
  let body = part.slice(bodyStart);

  if (cte === "quoted-printable") {
    body = decodeQP(body);
  } else if (cte === "base64") {
    try { body = atob(body.replace(/\s+/g, "")); } catch { /* leave as-is */ }
  }

  return body;
}

function decodeQP(input) {
  // Decode =XX hex sequences and soft line breaks (= at end of line)
  return input
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}
