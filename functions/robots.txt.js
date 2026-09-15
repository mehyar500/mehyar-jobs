// GET /robots.txt — crawlers welcome on SEO surfaces; keep API + admin out.
import { APP_URL } from "./_shared/seo.js";

export async function onRequestGet() {
  const body = [
    "User-agent: *",
    "Allow: /job/",
    "Allow: /jobs/",
    "Allow: /roast/",
    "Allow: /sitemap",
    "Disallow: /api/",
    "Disallow: /admin",
    "Disallow: /applications",
    "Disallow: /pipeline",
    "Disallow: /profile",
    "Disallow: /unsubscribe?token=", // signed one-click tokens are private
    "",
    `Sitemap: ${APP_URL}/sitemap.xml`,
    "",
  ].join("\n");
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" },
  });
}
