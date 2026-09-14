// GET /sitemap.xml — sitemap index (job detail chunks + SEO pages).
import { APP_URL } from "./_shared/seo.js";
import { ensureSchema } from "./_shared/db.js";

export const JOBS_PER_SITEMAP = 5000;

export async function onRequestGet({ env }) {
  await ensureSchema(env).catch(() => null);
  const db = env?.JOBS_DB;
  let total = 0;
  if (db) {
    const r = await db.prepare("SELECT COUNT(*) AS n FROM job WHERE is_active = 1").first().catch(() => ({ n: 0 }));
    total = r?.n || 0;
  }
  const chunks = Math.max(1, Math.ceil(total / JOBS_PER_SITEMAP));
  const urls = [];
  for (let i = 1; i <= chunks; i++) urls.push(`${APP_URL}/sitemap/jobs-${i}.xml`);
  urls.push(`${APP_URL}/sitemap/seo.xml`);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
    urls.map((u) => `  <sitemap><loc>${u}</loc></sitemap>`).join("\n")
  }\n</sitemapindex>`;
  return new Response(xml, {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600, s-maxage=21600" },
  });
}
