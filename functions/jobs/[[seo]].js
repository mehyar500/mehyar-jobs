// GET /jobs/<title-slug>[/<city-slug>] — server-rendered programmatic SEO
// listing pages. /jobs itself falls through to the SPA (admin job browser).
//
// Pages carry unique intro copy generated from live data (counts, top
// companies, remote share, salary band) plus an ItemList of job links.

import { ensureSchema } from "../_shared/db.js";
import {
  esc, pageChrome, jobSlug, APP_URL,
} from "../_shared/seo.js";

const STOP = new Set("a,an,the,and,or,of,to,in,on,for,with,at,by,from,as,is,are,was,were,be,been,job,jobs,role,roles,position,open,opening,new".split(","));

function keywords(slug) {
  return String(slug || "").toLowerCase().split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOP.has(w))
    .slice(0, 6);
}

function humanize(slug) {
  return String(slug || "").split(/[^a-zA-Z0-9]+/).filter(Boolean)
    .map((w) => w.length <= 2 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function money(n) {
  return n == null ? null : `$${Math.round(Number(n) / 1000)}k`;
}

async function fetchJobs(db, titleKw, cityKw, limit = 100) {
  const where = ["j.is_active = 1"];
  const binds = [];
  for (const kw of titleKw) { where.push("lower(j.title) LIKE ?"); binds.push(`%${kw}%`); }
  for (const kw of cityKw) { where.push("lower(j.location) LIKE ?"); binds.push(`%${kw}%`); }
  const rows = await db.prepare(`
    SELECT j.id, j.title, j.url, j.location, j.remote_policy, j.employment_type,
           j.salary_min, j.salary_max, j.first_seen_at,
           c.name AS company_name
    FROM job j JOIN company c ON c.id = j.company_id
    WHERE ${where.join(" AND ")}
    ORDER BY j.first_seen_at DESC
    LIMIT ?
  `).bind(...binds, limit).all().catch(() => ({ results: [] }));
  return rows.results || [];
}

function introCopy({ title, city, count, companies, remotePct, salary, newest }) {
  const where = city ? `in ${city}` : "across the US";
  const bits = [
    `There ${count === 1 ? "is" : "are"} currently <strong>${count} open ${esc(title)} ${count === 1 ? "role" : "roles"}</strong> ${where} on mehyar.jobs — every one scraped from the company's own careers page and free to browse.`,
  ];
  if (companies.length) bits.push(`Hiring now: ${companies.map((c) => `<strong>${esc(c)}</strong>`).join(", ")}.`);
  if (remotePct > 0) bits.push(`${remotePct}% of these roles are remote.`);
  if (salary) bits.push(`Posted pay bands run ${salary}.`);
  if (newest) bits.push(`Newest listing added ${newest}.`);
  bits.push(`Create a <a href="${APP_URL}/signup">free account</a> and we'll fit-score every one against your resume and email you the new matches daily — free forever.`);
  return `<p>${bits.join(" ")}</p>`;
}

export async function onRequestGet({ request, env, params }) {
  const segs = params?.seo || [];

  // /jobs → the SPA (admin browser). Fall through to static assets.
  if (!segs.length) {
    if (env?.ASSETS) return env.ASSETS.fetch(request);
    return new Response("not found", { status: 404 });
  }
  if (segs.length > 2) return new Response("not found", { status: 404 });

  // /jobs/browse — hub of top title/city combos.
  if (segs.length === 1 && segs[0] === "browse") return hub(env);

  await ensureSchema(env).catch(() => null);
  const db = env?.JOBS_DB;
  if (!db) return new Response("no db", { status: 500 });

  const titleSlug = segs[0];
  const citySlug = segs[1] || null;
  const titleKw = keywords(titleSlug);
  const cityKw = citySlug ? keywords(citySlug) : [];
  if (!titleKw.length) return new Response("not found", { status: 404 });

  const title = humanize(titleSlug);
  const city = citySlug ? humanize(citySlug) : null;
  const jobs = await fetchJobs(db, titleKw, cityKw);
  if (!jobs.length) {
    const html = pageChrome({
      title: `${title} jobs${city ? ` in ${city}` : ""} — mehyar.jobs`,
      description: `No open ${title} roles${city ? ` in ${city}` : ""} right now. Set a free alert and we'll email you when one appears.`,
      body: `<h1>${esc(title)} jobs${city ? ` in ${esc(city)}` : ""}</h1>
        <p class="muted">No open roles match right now — new jobs land daily.</p>
        <p><a class="btn" href="${APP_URL}/signup">🔔 Alert me free when one appears</a></p>`,
      noindex: true,
    });
    return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  const companies = [...new Set(jobs.map((j) => j.company_name))].slice(0, 5);
  const remotePct = Math.round(100 * jobs.filter((j) => j.remote_policy === "remote").length / jobs.length);
  const salMin = jobs.map((j) => j.salary_min).filter(Boolean);
  const salMax = jobs.map((j) => j.salary_max).filter(Boolean);
  const salary = (salMin.length || salMax.length)
    ? `${salMin.length ? money(Math.min(...salMin)) : ""}${salMax.length ? `–${money(Math.max(...salMax))}` : ""}/yr`
    : null;
  const newest = jobs[0]?.first_seen_at ? jobs[0].first_seen_at.slice(0, 10) : null;

  const canonical = citySlug
    ? `${APP_URL}/jobs/${esc(titleSlug)}/${esc(citySlug)}`
    : `${APP_URL}/jobs/${esc(titleSlug)}`;

  const items = jobs.map((j) => `
    <li>
      <a href="${APP_URL}/job/${j.id}-${jobSlug(j)}" style="font-weight:600">${esc(j.title)}</a>
      <span class="muted"> — ${esc(j.company_name)}${j.location ? ` · ${esc(j.location)}` : ""}${j.remote_policy === "remote" ? " · 🌐 remote" : ""}</span>
    </li>`).join("");

  const itemListLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `${title} jobs${city ? ` in ${city}` : ""}`,
    itemListElement: jobs.slice(0, 50).map((j, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: `${APP_URL}/job/${j.id}-${jobSlug(j)}`,
      name: `${j.title} at ${j.company_name}`,
    })),
  };

  const html = pageChrome({
    title: `${title} jobs${city ? ` in ${city}` : ""} (${jobs.length} open) — mehyar.jobs`,
    description: `${jobs.length} open ${title} roles${city ? ` in ${city}` : ""} — scraped from company career pages, fit-scored free on mehyar.jobs.`,
    canonical,
    jsonLd: itemListLd,
    body: `
<h1>${esc(title)} jobs${city ? ` in ${esc(city)}` : ""}</h1>
<p class="muted">${jobs.length} open roles · updated daily</p>
<div class="card">${introCopy({ title, city, count: jobs.length, companies, remotePct, salary, newest })}</div>
<h2>Open roles</h2>
<ul class="joblist">${items}</ul>
<p style="margin-top:24px"><a class="btn" href="${APP_URL}/signup">Get these matched to my resume — free</a></p>`,
  });

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}

async function hub(env) {
  await ensureSchema(env).catch(() => null);
  const db = env?.JOBS_DB;
  // Top title words and top cities by live job count — real data only.
  const titles = await db.prepare(`
    SELECT lower(j.title) AS t, COUNT(*) AS n FROM job j
    WHERE j.is_active = 1 GROUP BY t ORDER BY n DESC LIMIT 60
  `).all().catch(() => ({ results: [] }));
  const cities = await db.prepare(`
    SELECT j.location AS loc, COUNT(*) AS n FROM job j
    WHERE j.is_active = 1 AND j.location IS NOT NULL AND j.location != ''
    GROUP BY loc ORDER BY n DESC LIMIT 40
  `).all().catch(() => ({ results: [] }));

  const { slugify } = await import("../_shared/seo.js");
  const titleLinks = (titles.results || [])
    .filter((r) => (r.t || "").split(" ").length <= 5)
    .slice(0, 24)
    .map((r) => `<li><a href="${APP_URL}/jobs/${slugify(r.t)}">${esc(r.t.replace(/\b\w/g, (c) => c.toUpperCase()))} jobs</a> <span class="muted">(${r.n})</span></li>`)
    .join("");
  const cityLinks = (cities.results || []).slice(0, 24)
    .map((r) => `<li><a href="${APP_URL}/jobs/software-engineer/${slugify(r.loc)}">Software engineer jobs in ${esc(r.loc)}</a> <span class="muted">(${r.n})</span></li>`)
    .join("");

  const html = pageChrome({
    title: "Browse jobs by title and city — mehyar.jobs",
    description: "Browse thousands of open roles by job title and city. Free fit scoring, free alerts, free forever.",
    canonical: `${APP_URL}/jobs/browse`,
    body: `<h1>Browse jobs</h1>
      <div class="card"><h2 style="margin-top:0">By title</h2><ul class="joblist">${titleLinks}</ul></div>
      <div class="card"><h2 style="margin-top:0">Software engineer by city</h2><ul class="joblist">${cityLinks}</ul></div>`,
  });
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600, s-maxage=86400" },
  });
}
