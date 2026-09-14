// GET /job/<id> or /job/<id>-<slug> — server-rendered job detail page.
//
// Google's JobPosting rich results require server-rendered HTML carrying
// valid JobPosting JSON-LD — the client SPA can never qualify, so this
// route renders the full page at the edge. The SPA route is untouched.

import { ensureSchema } from "../_shared/db.js";
import {
  esc, pageChrome, jobPostingJsonLd, jobSlug, stripHtml,
  APP_URL,
} from "../_shared/seo.js";

function money(n) {
  return n == null ? null : `$${Number(n).toLocaleString("en-US")}`;
}

export async function onRequestGet({ request, env, params }) {
  const raw = String(params?.id || "");
  const id = parseInt(raw, 10);
  if (!Number.isFinite(id)) return notFound();

  await ensureSchema(env).catch(() => null);
  const db = env?.JOBS_DB;
  if (!db) return new Response("no db", { status: 500 });

  const job = await db.prepare(`
    SELECT j.id, j.title, j.url, j.location, j.remote_policy, j.employment_type,
           j.salary_min, j.salary_max, j.salary_currency, j.posted_at,
           j.first_seen_at, j.description, j.description_text,
           j.featured, j.featured_until,
           c.name AS company_name, c.slug AS company_slug, c.industry, c.careers_url
    FROM job j JOIN company c ON c.id = j.company_id
    WHERE j.id = ? AND j.is_active = 1
  `).bind(id).first().catch(() => null);
  if (!job) return notFound();

  const canonical = `${APP_URL}/job/${job.id}-${jobSlug(job)}`;
  const ld = jobPostingJsonLd(job, {
    name: job.company_name,
    careers_url: job.careers_url,
  });

  const desc = (job.description_text && job.description_text.trim())
    || stripHtml(job.description);
  const salary = (job.salary_min || job.salary_max)
    ? `${money(job.salary_min) || ""}${job.salary_max ? ` – ${money(job.salary_max)}` : ""} ${job.salary_currency || "USD"}/yr`
    : null;
  const posted = (job.posted_at || job.first_seen_at || "").slice(0, 10);
  const featured = job.featured === 1 && (!job.featured_until || job.featured_until > new Date().toISOString().slice(0, 19).replace("T", " "));

  const body = `
<nav class="muted" style="margin-bottom:16px"><a href="${APP_URL}">Home</a> · <a href="${APP_URL}/matches">My matches</a></nav>
${featured ? `<div style="margin-bottom:12px"><span class="sponsored">Sponsored</span> <span class="badge-featured">⭐ Featured listing</span></div>` : ""}
<h1>${esc(job.title)}</h1>
<p class="muted" style="font-size:16px">${esc(job.company_name)}${job.location ? ` · ${esc(job.location)}` : ""}${job.remote_policy === "remote" ? " · 🌐 Remote" : ""}</p>
<div style="margin:12px 0">
  ${job.employment_type ? `<span class="pill">${esc(job.employment_type.replace(/_/g, " "))}</span> ` : ""}
  ${salary ? `<span class="pill">💰 ${esc(salary)}</span> ` : ""}
  ${posted ? `<span class="pill">📅 ${esc(posted)}</span>` : ""}
</div>
<div class="card">
  <h2 style="margin-top:0">About this role</h2>
  <p>${esc(desc.slice(0, 8000)).replace(/\n/g, "<br>") || "See the original posting for the full description."}</p>
  ${desc.length > 8000 ? `<p class="muted">…continued on the employer's site.</p>` : ""}
</div>
<a class="btn" href="${esc(job.url)}" rel="nofollow noopener" target="_blank">Apply on ${esc(job.company_name)} →</a>
<p class="muted" style="margin-top:16px">Want jobs like this matched to <em>your</em> resume, free?
<a href="${APP_URL}/signup">Create a free account</a> — daily alerts, AI resume review, zero cost, forever.</p>
<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Jobs", item: APP_URL },
      { "@type": "ListItem", position: 2, name: job.title, item: canonical },
    ],
  })}</script>`;

  const html = pageChrome({
    title: `${job.title} at ${job.company_name} — mehyar.jobs`,
    description: `${job.title} at ${job.company_name}${job.location ? ` in ${job.location}` : ""}${salary ? `, ${salary}` : ""}. Free job match on mehyar.jobs.`,
    canonical,
    jsonLd: ld,
    og: {
      title: `${job.title} at ${job.company_name}`,
      description: `${job.title}${job.location ? ` · ${job.location}` : ""}${salary ? ` · ${salary}` : ""} — free on mehyar.jobs`,
      url: canonical,
    },
    body,
  });

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}

function notFound() {
  const html = pageChrome({
    title: "Job not found — mehyar.jobs",
    description: "That listing is gone. Browse thousands of live jobs on mehyar.jobs.",
    body: `<h1>That listing is gone</h1><p class="muted">It may have been filled or removed. <a href="${"https://jobs.mehyar.us"}">Browse live jobs →</a></p>`,
    noindex: true,
  });
  return new Response(html, { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
