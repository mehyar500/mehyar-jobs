// _shared/seo.js
//
// Server-rendered SEO helpers for the growth engine:
//  - JobPosting JSON-LD (Google Jobs rich-result eligibility)
//  - slugify / normalization for /jobs/<title>/<city> pages
//  - HTML escaping + full-page chrome for crawler-facing pages
//
// Job seekers stay free; employer/advertiser inventory is always labeled.

export const APP_URL = "https://jobs.mehyar.us";

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

export function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function jobSlug(job) {
  return slugify(`${job.title || "job"} ${job.company_name || ""}`);
}

// Google JobPosting employmentType enum mapping
export function employmentTypeEnum(t) {
  const m = {
    full_time: "FULL_TIME",
    part_time: "PART_TIME",
    contract: "CONTRACTOR",
    intern: "INTERN",
    temporary: "TEMPORARY",
  };
  return m[String(t || "").toLowerCase()] || null;
}

// "New York, NY" -> { locality: "New York", region: "NY" }
export function parseLocation(loc) {
  const raw = String(loc || "").split("|")[0].trim();
  if (!raw || /^remote/i.test(raw)) return null;
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { locality: parts.slice(0, -1).join(", "), region: parts[parts.length - 1].slice(0, 60) };
  }
  return { locality: parts[0].slice(0, 120), region: null };
}

export function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isoDate(d) {
  if (!d) return null;
  const t = new Date(String(d).replace(" ", "T"));
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

// Build a Google-valid JobPosting JSON-LD object.
// Required: title, description, datePosted, hiringOrganization, jobLocation.
// Recommended: employmentType, baseSalary, validThrough, identifier.
export function jobPostingJsonLd(job, company) {
  const description = (job.description_text && job.description_text.trim())
    || stripHtml(job.description).slice(0, 50000)
    || `${job.title} at ${company?.name || "a hiring company"}. Apply via the original posting.`;
  const datePosted = isoDate(job.posted_at) || isoDate(job.first_seen_at) || new Date().toISOString();

  const org = { "@type": "Organization", name: company?.name || job.company_name || "Hiring company" };
  if (company?.careers_url) org.sameAs = company.careers_url;

  const loc = parseLocation(job.location);
  const jobLocation = loc
    ? { "@type": "Place", address: { "@type": "PostalAddress", addressLocality: loc.locality, ...(loc.region ? { addressRegion: loc.region } : {}) } }
    : (String(job.remote_policy || "").toLowerCase() === "remote"
        ? { "@type": "Place", address: { "@type": "PostalAddress", addressCountry: "US" } }
        : undefined);

  const ld = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: job.title,
    description,
    datePosted,
    hiringOrganization: org,
    identifier: {
      "@type": "PropertyValue",
      name: "mehyar.jobs",
      value: `mehyar-jobs-${job.id}`,
    },
    url: `${APP_URL}/job/${job.id}-${jobSlug(job)}`,
  };
  if (jobLocation) ld.jobLocation = jobLocation;
  const et = employmentTypeEnum(job.employment_type);
  if (et) ld.employmentType = et;
  if (job.remote_policy === "remote") ld.jobLocationType = "TELECOMMUTE";
  if (job.salary_min || job.salary_max) {
    ld.baseSalary = {
      "@type": "MonetaryAmount",
      currency: job.salary_currency || "USD",
      value: {
        "@type": "QuantitativeValue",
        ...(job.salary_min ? { minValue: Number(job.salary_min) } : {}),
        ...(job.salary_max ? { maxValue: Number(job.salary_max) } : {}),
        unitText: "YEAR",
      },
    };
  }
  // Listings expire ~60 days after posting for freshness signals.
  const vt = new Date(datePosted);
  vt.setDate(vt.getDate() + 60);
  ld.validThrough = vt.toISOString();
  return ld;
}

// Minimal crawler-friendly page chrome (dark, on-brand).
export function pageChrome({ title, description, canonical, jsonLd, og, body, noindex = false }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description || "")}">
${noindex ? '<meta name="robots" content="noindex,nofollow">' : ""}
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ""}
${og ? `
<meta property="og:type" content="${esc(og.type || "website")}">
<meta property="og:title" content="${esc(og.title || title)}">
<meta property="og:description" content="${esc(og.description || description || "")}">
<meta property="og:url" content="${esc(og.url || canonical || APP_URL)}">
${og.image ? `<meta property="og:image" content="${esc(og.image)}">` : ""}
<meta name="twitter:card" content="summary_large_image">
` : ""}
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : ""}
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0b0b10;color:#e7e7ec;margin:0;line-height:1.6}
.wrap{max-width:860px;margin:0 auto;padding:32px 20px}
a{color:#a78bfa}
.card{background:#14141b;border:1px solid #26262f;border-radius:12px;padding:20px;margin:16px 0}
.pill{display:inline-block;background:#2a2140;color:#c4b5fd;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600}
.sponsored{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#f59e0b;border:1px solid #f59e0b;border-radius:6px;padding:2px 8px}
.btn{display:inline-block;background:#7c3aed;color:#fff!important;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;margin-top:12px}
.muted{color:#9a9aa5;font-size:14px}
h1{font-size:28px;margin:0 0 8px}
h2{font-size:20px;margin:28px 0 8px}
.joblist{list-style:none;padding:0;margin:0}
.joblist li{border-bottom:1px solid #26262f;padding:14px 0}
.badge-featured{display:inline-block;background:rgba(245,158,11,.15);color:#fbbf24;border-radius:6px;padding:2px 10px;font-size:12px;font-weight:700;margin-left:8px}
footer{margin-top:48px;padding-top:20px;border-top:1px solid #26262f;color:#71717a;font-size:13px}
</style>
</head>
<body><div class="wrap">
<header><a href="${APP_URL}" style="text-decoration:none;color:#e7e7ec;font-weight:800;font-size:18px">⚡ mehyar.jobs</a>
<span class="muted"> · free job search, free forever</span></header>
${body}
<footer>mehyar.jobs · <a href="${APP_URL}">jobs.mehyar.us</a> · Free for job seekers, always. Employers &amp; advertisers keep it free.</footer>
</div></body></html>`;
}
