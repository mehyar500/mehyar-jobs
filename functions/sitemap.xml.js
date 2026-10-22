// GET /sitemap.xml — sitemap index (SEO pages only).
//
// 2026-10-22 VISIBILITY PRUNE (Mayor's order via the Product Chief): the
// per-job chunk sitemaps (jobs-1.xml, jobs-2.xml — 7,582 programmatic
// /job/<id> locs) were removed from the index. They were the fleet's
// largest "Crawled - currently not indexed" generator (the SproutScore
// pattern). The job pages themselves still serve; they are simply no
// longer submitted. seo.xml (inventory listing pages + static pages)
// is the genuine remainder and stays.
import { APP_URL } from "./_shared/seo.js";

// Kept for module compatibility (functions/sitemap/[chunk].js imports it).
export const JOBS_PER_SITEMAP = 5000;

export async function onRequestGet() {
  const urls = [`${APP_URL}/sitemap/seo.xml`];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <sitemap><loc>${u}</loc></sitemap>`)
    .join("\n")}\n</sitemapindex>`;
  return new Response(xml, {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600, s-maxage=21600" },
  });
}
