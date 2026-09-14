// GET /roast/<public_id> — public shareable resume roast card.
//
// Server-rendered so link unfurls carry OG meta tags. PII-stripped by
// construction: the roast row holds only score/verdict/strengths/gaps —
// no name, email, phone, or resume text ever touches this table.

import { ensureSchema } from "../_shared/db.js";
import { esc, pageChrome, APP_URL } from "../_shared/seo.js";

function grade(score) {
  if (score >= 80) return { label: "Hired energy", emoji: "🔥" };
  if (score >= 60) return { label: "Solid, needs polish", emoji: "💪" };
  if (score >= 40) return { label: "Needs work", emoji: "🛠️" };
  return { label: "Roasted", emoji: "🍖" };
}

export async function onRequestGet({ env, params }) {
  const pid = String(params?.id || "").slice(0, 32);
  await ensureSchema(env).catch(() => null);
  const db = env?.JOBS_DB;

  const roast = pid && db
    ? await db.prepare("SELECT public_id, score, verdict, strengths_json, gaps_json, created_at FROM roast WHERE public_id = ?")
      .bind(pid).first().catch(() => null)
    : null;

  if (!roast) {
    const html = pageChrome({
      title: "Roast not found — mehyar.jobs",
      description: "That resume roast link is gone. Get your own free AI resume roast on mehyar.jobs.",
      body: `<h1>Roast not found</h1><p class="muted">That link is gone or was deleted. <a href="${APP_URL}/review">Get your own free AI resume roast →</a></p>`,
      noindex: true,
    });
    return new Response(html, { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  const g = grade(roast.score || 0);
  const strengths = JSON.parse(roast.strengths_json || "[]");
  const gaps = JSON.parse(roast.gaps_json || "[]");
  const url = `${APP_URL}/roast/${roast.public_id}`;
  const ogTitle = `${g.emoji} My resume scored ${roast.score}/100 — ${g.label}`;

  const body = `
<div class="card" style="text-align:center;padding:40px 24px">
  <div style="font-size:15px" class="muted">🔥 RESUME ROAST · mehyar.jobs</div>
  <div style="font-size:84px;font-weight:800;margin:12px 0">${roast.score}<span style="font-size:28px" class="muted">/100</span></div>
  <div style="font-size:20px;font-weight:700">${g.emoji} ${esc(g.label)}</div>
  ${roast.verdict ? `<p style="max-width:560px;margin:12px auto 0">${esc(roast.verdict)}</p>` : ""}
</div>
${strengths.length ? `<div class="card"><h2 style="margin-top:0">💪 Strengths</h2><ul>${strengths.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
${gaps.length ? `<div class="card"><h2 style="margin-top:0">🎯 Gaps to fix</h2><ul>${gaps.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
<p class="muted">Anonymous roast — no names, no contact info. Scored by the mehyar.jobs AI fit engine.</p>
<a class="btn" href="${APP_URL}/review">🔥 Roast my resume — free</a>
<p class="muted" style="margin-top:12px">Plus: daily job alerts matched to you, 7,000+ jobs fit-scored. Free forever.</p>`;

  const html = pageChrome({
    title: `${ogTitle} — mehyar.jobs roast`,
    description: `An anonymous AI resume roast: ${roast.score}/100. Get yours free on mehyar.jobs.`,
    canonical: url,
    og: { title: ogTitle, description: roast.verdict || "Anonymous AI resume roast — get yours free.", url, type: "website" },
    body,
  });
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600, s-maxage=86400" },
  });
}
