// GET /gear/<product-slug> — per-product landing pages for the email
// growth engine (Worker 6).
//
// Built from the product_slot catalog (migrations 0018/0019):
//   * active=1 AND approved=1 -> full page: name, description, image (or a
//     graceful placeholder when image_url is NULL), and the affiliate CTA.
//     The raw affiliate URL never appears in the HTML — the CTA goes
//     through the tap-tracked /r/<id> redirect (mintLink), and the page
//     carries a clear #ad affiliate disclosure.
//   * anything else (incl. yotru / jobtestprep, approved=0) -> the page
//     EXISTS but shows "not available yet" and NEVER an affiliate link.
//   * unknown slug -> 404.
//
// Campaign emails link here (weave.url = /gear/<slug>), never to Amazon.

import { ensureSchema } from "../_shared/db.js";
import { pageChrome, APP_URL } from "../_shared/seo.js";
import { getProductBySlug } from "../_shared/productCatalog.js";
import { mintLink } from "../_shared/sms.js";
import { DATE_RE, esc, recordLandingClick, buildGearPage, notFoundPage } from "../_shared/landing.js";

const CT = { "Content-Type": "text/html; charset=utf-8" };

export async function onRequestGet({ request, env, params }) {
  await ensureSchema(env).catch(() => null);
  const db = env?.JOBS_DB;
  const slug = String(params?.slug || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 64);
  const product = db && slug ? await getProductBySlug(db, slug) : null;
  if (!product) {
    return new Response(pageChrome({ title: "Not found — mehyar.jobs", noindex: true, body: notFoundPage("Product not found") }), { status: 404, headers: CT });
  }

  const eligible = product.active === 1 && product.approved === 1 && String(product.url || "").trim() !== "";
  const appUrl = env.JOBS_APP_URL || APP_URL;
  const url = new URL(request.url);
  const d = url.searchParams.get("d");
  const dateStr = DATE_RE.test(d || "") ? d : new Date().toISOString().slice(0, 10);

  // Attribution: log the page view against today's (or ?d=) landing stats.
  await recordLandingClick(db, {
    date: dateStr, pageType: "gear", slug, productSlug: slug,
    contactId: null, ip: request.headers.get("cf-connecting-ip"),
  });

  let ctaUrl = null;
  if (eligible) {
    // Tap-tracked redirect — the raw affiliate URL stays out of the page.
    const publicId = await mintLink(db, {
      contactId: null, kind: "gear_click",
      targetUrl: String(product.url).trim(), offerSlot: slug,
    });
    ctaUrl = `${appUrl}/r/${publicId}`;
  }

  const html = pageChrome({
    title: `${product.name} — mehyar.jobs gear`,
    description: product.description || `mehyar.jobs gear pick: ${product.name}`,
    noindex: true,
    body: buildGearPage({ product, eligible, ctaUrl }),
  });
  return new Response(html, { headers: { ...CT, "Cache-Control": "public, max-age=300" } });
}
