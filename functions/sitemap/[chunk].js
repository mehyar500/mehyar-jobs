// GET /sitemap/<chunk>.xml — chunked URL lists.
//   jobs-N.xml — job detail pages (5000 per chunk, newest first)
//   seo.xml    — programmatic SEO listing pages with real inventory (>=3 jobs)

import { ensureSchema } from "../_shared/db.js";
import { slugify, jobSlug, APP_URL } from "../_shared/seo.js";
import { JOBS_PER_SITEMAP } from "../sitemap.xml.js";

function xml(urls) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
    urls.map((u) => `  <url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}${u.changefreq ? `<changefreq>${u.changefreq}</changefreq>` : ""}</url>`).join("\n")
  }\n</urlset>`;
}

function send(urls) {
  return new Response(xml(urls), {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600, s-maxage=21600" },
  });
}

export async function onRequestGet({ env, params }) {
  const chunk = String(params?.chunk || "").replace(/\.xml$/, "");
  await ensureSchema(env).catch(() => null);
  const db = env?.JOBS_DB;
  if (!db) return new Response("no db", { status: 500 });

  const jm = chunk.match(/^jobs-(\d+)$/);
  if (jm) {
    const n = Math.max(1, parseInt(jm[1], 10));
    const rows = await db.prepare(`
      SELECT j.id, j.title, j.last_seen_at, c.name AS company_name
      FROM job j JOIN company c ON c.id = j.company_id
      WHERE j.is_active = 1
      ORDER BY j.first_seen_at DESC
      LIMIT ? OFFSET ?
    `).bind(JOBS_PER_SITEMAP, (n - 1) * JOBS_PER_SITEMAP).all().catch(() => ({ results: [] }));
    const urls = (rows.results || []).map((j) => ({
      loc: `${APP_URL}/job/${j.id}-${jobSlug(j)}`,
      lastmod: (j.last_seen_at || "").slice(0, 10) || undefined,
      changefreq: "daily",
    }));
    return send(urls);
  }

  if (chunk === "seo") {
    // Real title/city pairs with >= 3 live jobs — only pages with inventory.
    const rows = await db.prepare(`
      SELECT lower(j.title) AS t, j.location AS loc, COUNT(*) AS n
      FROM job j
      WHERE j.is_active = 1 AND j.location IS NOT NULL AND j.location != ''
      GROUP BY t, loc HAVING n >= 3
      ORDER BY n DESC LIMIT 2000
    `).all().catch(() => ({ results: [] }));
    const seen = new Set();
    const urls = [{ loc: `${APP_URL}/jobs/browse`, changefreq: "daily" }];
    for (const r of (rows.results || [])) {
      const t = slugify(r.t);
      const c = slugify(r.loc);
      if (!t || !c) continue;
      const key = `${t}/${c}`;
      if (seen.has(key)) continue;
      seen.add(key);
      urls.push({ loc: `${APP_URL}/jobs/${t}/${c}`, changefreq: "daily" });
    }
    // Title-only pages for the top titles.
    const tops = await db.prepare(`
      SELECT lower(j.title) AS t, COUNT(*) AS n FROM job j
      WHERE j.is_active = 1 GROUP BY t HAVING n >= 10
      ORDER BY n DESC LIMIT 300
    `).all().catch(() => ({ results: [] }));
    for (const r of (tops.results || [])) {
      const t = slugify(r.t);
      if (!t || seen.has(t)) continue;
      seen.add(t);
      urls.push({ loc: `${APP_URL}/jobs/${t}`, changefreq: "daily" });
    }
    return send(urls.slice(0, 5000));
  }

  return new Response("not found", { status: 404 });
}
