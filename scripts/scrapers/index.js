// scripts/scrapers/index.js
//
// Zero-secret career-page scraper. Walks the company directory, calls
// each public careers URL, normalizes the result into our `job` schema.
//
// Each ATS has a public JSON or public HTML endpoint we can hit without
// any API key:
//
//   Greenhouse:       GET /boards/{handle}        (JSON; no key)
//                     GET /boards/{handle}/jobs    (JSON)
//   Lever:            GET /v0/postings/{handle}    (JSON; no key)
//   Ashby:            GET /api/non-user-graphql    (POST GraphQL; no key)
//   SmartRecruiters:  GET /api-1.0/postings       (JSON; needs company id; can fall back to HTML)
//   Workday:          GET /ccx/api/v1/{tenant}/jobs (JSON; CX-1001-like)
//   Plain HTML:       fetch & regex-link extraction
//   LinkedIn:         not crawled (gates aggressively); we mark `linkedin` kind and skip
//
// All scrapers return the same shape: [{ external_id, url, title, dept,
// team, location, remote_policy, employment_type, posted_at, raw }, ...]

// All scrapers fetch with a User-Agent + low retry budget. The Workers
// runtime gives us 50 subrequests per invocation; we batch company-by-
// company to stay inside.

const UA = "Mozilla/5.0 (compatible; MehyarJobs/0.1; +https://mehyar.us/jobs)";

// Tiny helpers
async function fetchJson(url, { timeoutMs = 15000, method = "GET", headers = {}, body } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method,
      headers: {
        "user-agent": UA,
        "accept": "application/json, text/html;q=0.9, */*;q=0.5",
        ...headers,
      },
      body,
      signal: ctl.signal,
    });
    if (!r.ok) return { ok: false, status: r.status, body: await r.text().catch(() => "") };
    const text = await r.text();
    try { return { ok: true, status: r.status, json: JSON.parse(text), text }; }
    catch { return { ok: true, status: r.status, json: null, text }; }
  } catch (e) {
    return { ok: false, status: 0, error: e?.message || String(e) };
  } finally {
    clearTimeout(t);
  }
}

export function normLoc(s) {
  if (!s) return { location: null, remote_policy: "unknown" };
  const t = s.trim();
  const l = t.toLowerCase();
  if (l === "anywhere" || /\b(remote|work from anywhere|distributed)\b/.test(l)) {
    return { location: t, remote_policy: "remote" };
  }
  if (l.includes("hybrid")) return { location: t, remote_policy: "hybrid" };
  if (l.includes("on-site") || l.includes("onsite")) return { location: t, remote_policy: "onsite" };
  return { location: t, remote_policy: "unknown" };
}

export function inferEmploymentType(value, title = "", description = "") {
  const explicit = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (/^(contract|contractor|freelance|1099|c2c)$/.test(explicit)) return "contract";
  if (/^(temporary|temp|fixed_term)$/.test(explicit)) return "temporary";
  if (/^(part_time|parttime)$/.test(explicit)) return "part_time";
  if (/^(intern|internship)$/.test(explicit)) return "intern";
  if (/^(full_time|fulltime|regular|permanent)$/.test(explicit)) return "full_time";

  const heading = String(title || "");
  if (/\b(contract(?:or)?|freelance|1099|c2c)\b/i.test(heading)) return "contract";
  if (/\b(temporary|temp|fixed[- ]term)\b/i.test(heading)) return "temporary";
  const text = String(description || "").slice(0, 5000);
  if (/\b(employment type|engagement|position type)\s*[:\-]\s*(contract(?:or)?|freelance|1099|c2c)\b/i.test(text) || /\b(1099|corp[- ]to[- ]corp|c2c)\s+(contract|engagement|role)\b/i.test(text)) return "contract";
  return explicit || null;
}

// ── Greenhouse ────────────────────────────────────────────────────
export async function scrapeGreenhouse(handle, ctx) {
  // https://boards-api.greenhouse.io/v1/boards/{handle}/jobs?content=true
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(handle)}/jobs?content=true`;
  const r = await fetchJson(url, { headers: { accept: "application/json" } });
  if (!r.ok) return { ok: false, error: `greenhouse_http_${r.status}` };
  const jobs = r.json?.jobs || [];
  return {
    ok: true,
    items: jobs.map((j) => {
      const loc = normLoc(j.location?.name);
      const offices = (j.offices || []).map((o) => o.name).filter(Boolean);
      return {
        external_id: String(j.id),
        url: j.absolute_url,
        title: j.title,
        department: j.departments?.[0]?.name || null,
        team: offices.join(", ") || null,
        location: loc.location,
        remote_policy: loc.remote_policy,
        employment_type: inferEmploymentType(null, j.title, j.content ? stripHtml(j.content) : ""),
        posted_at: j.updated_at || null,
        description: null,
        description_text: j.content ? stripHtml(j.content) : null,
        raw: { source: "greenhouse", id: j.id, departments: j.departments, offices: j.offices },
      };
    }),
  };
}

// ── Lever ─────────────────────────────────────────────────────────
export async function scrapeLever(handle, ctx) {
  // https://api.lever.co/v0/postings/{handle}?mode=json
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(handle)}?mode=json`;
  const r = await fetchJson(url, { headers: { accept: "application/json" } });
  if (!r.ok) return { ok: false, error: `lever_http_${r.status}` };
  const arr = Array.isArray(r.json) ? r.json : [];
  return {
    ok: true,
    items: arr.map((j) => {
      const loc = normLoc(j.categories?.location || j.location);
      return {
        external_id: j.id,
        url: j.hostedUrl || j.applyUrl,
        title: j.text,
        department: j.categories?.department || null,
        team: j.categories?.team || null,
        location: loc.location,
        remote_policy: loc.remote_policy,
        employment_type: inferEmploymentType(j.categories?.commitment, j.text, j.description ? stripHtml(j.description) : ""),
        posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : null,
        description: null,
        description_text: j.description ? stripHtml(j.description) : null,
        raw: { source: "lever", categories: j.categories },
      };
    }),
  };
}

// ── Ashby ─────────────────────────────────────────────────────────
// Ashby's public board endpoint: GET https://api.ashbyhq.com/posting-api/job-board/{handle}
// (no auth required for job-board endpoint)
export async function scrapeAshby(handle, ctx) {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(handle)}`;
  const r = await fetchJson(url, { headers: { accept: "application/json" } });
  if (!r.ok) return { ok: false, error: `ashby_http_${r.status}` };
  const jobs = r.json?.jobs || [];
  return {
    ok: true,
    items: jobs.map((j) => {
      const loc = normLoc(j.location);
      const isRemote = j.isRemote || (j.location || "").toLowerCase().includes("remote");
      return {
        external_id: j.id,
        url: j.jobUrl || j.applyUrl,
        title: j.title,
        department: j.department || null,
        team: j.team || null,
        location: j.location,
        remote_policy: isRemote ? "remote" : loc.remote_policy,
        employment_type: inferEmploymentType(j.employmentType, j.title, j.descriptionHtml ? stripHtml(j.descriptionHtml) : ""),
        posted_at: j.publishedAt || null,
        description: null,
        description_text: j.descriptionHtml ? stripHtml(j.descriptionHtml) : null,
        raw: { source: "ashby", id: j.id, department: j.department, team: j.team },
      };
    }),
  };
}

// ── SmartRecruiters ───────────────────────────────────────────────
// Public listings endpoint: GET /api-1.0/postings?companyId={id}&limit=100
// Many companies expose a public postingId list. We'll try the simpler
// URL pattern first: https://jobs.smartrecruiters.com/{CompanySlug}
export async function scrapeSmartRecruiters(handle, ctx) {
  // Try JSON listings
  const apiUrl = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(handle)}/postings?limit=200`;
  const r = await fetchJson(apiUrl, { headers: { accept: "application/json" } });
  if (r.ok && r.json?.content) {
    const jobs = r.json.content;
    return {
      ok: true,
      items: jobs.map((j) => {
        const loc = normLoc(j.location?.country || j.location?.city || j.location?.fullLocation);
        return {
          external_id: j.id,
          url: `https://jobs.smartrecruiters.com/${handle}/${j.id}`,
          title: j.name,
          department: j.department?.label || null,
          team: j.team?.label || null,
          location: j.location?.fullLocation || loc.location,
          remote_policy: loc.remote_policy,
          employment_type: inferEmploymentType(j.typeOfEmployment?.label, j.name, j.jobDescription ? stripHtml(j.jobDescription) : ""),
          posted_at: j.releaseDate || null,
          description: null,
          description_text: j.jobDescription ? stripHtml(j.jobDescription) : null,
          raw: { source: "smartrecruiters", id: j.id, ref: j.ref },
        };
      }),
    };
  }
  // Fallback: scrape the public board HTML
  const htmlUrl = `https://jobs.smartrecruiters.com/${encodeURIComponent(handle)}`;
  const html = await fetchJson(htmlUrl, { headers: { accept: "text/html" } });
  if (!html.ok) return { ok: false, error: `smartrecruiters_http_${html.status}` };
  const links = extractJobLinks(html.text, htmlUrl);
  return {
    ok: true,
    items: links.map((l) => ({
      external_id: l.id || l.url,
      url: l.url,
      title: l.title,
      department: null,
      team: null,
      location: null,
      remote_policy: "unknown",
      employment_type: null,
      posted_at: null,
      description: null,
      description_text: null,
      raw: { source: "smartrecruiters_html", href: l.href },
    })),
  };
}

// ── Workday ───────────────────────────────────────────────────────
// Workday boards expose a public CCX API:
//   GET https://{tenant}.wd{N}.myworkdayjobs.com/ccx/api/v1/{tenant}/jobs
// Tenant prefix varies. We try a few common variants.
export async function scrapeWorkday(careersUrl, handle, ctx) {
  // careersUrl like https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001
  // We need to find the CCX endpoint, which usually lives at
  //   https://{tenant}.wd{N}.myworkdayjobs.com/{tenant}/jobs
  // or
  //   https://{tenant}.wd{N}.myworkdayjobs.com/en-US/{tenant}_Careers/jobs
  //
  // To stay generic, we parse the URL and try a few common shapes.
  let u;
  try { u = new URL(careersUrl); }
  catch { return { ok: false, error: "bad_workday_url" }; }

  const host = u.host;                       // jpmc.fa.oraclecloud.com (skip)
  const parts = u.pathname.split("/").filter(Boolean);
  const lastSegment = parts[parts.length - 1] || "";

  // Determine the wd-host. If the source URL is *not* myworkdayjobs, we
  // need to discover the corresponding wd host. We assume: tenant-first
  // subdomain of original URL → wd1.myworkdayjobs.com.
  const hostBase = host.split(".")[0];
  const wdHost = `${hostBase}.wd1.myworkdayjobs.com`;
  const wdBase = `https://${wdHost}`;

  // Try a couple of job-board slug variants
  const candidates = [
    `${wdBase}/job/${handle}_Careers`,
    `${wdBase}/job/${handle}`,
    `${wdBase}/jobs`,
    `${wdBase}/${lastSegment}`,
  ];
  for (const c of candidates) {
    const r = await fetchJson(c, { headers: { accept: "application/json", "x-calypso": "csr" } });
    if (r.ok && r.json?.jobPostings) {
      const items = r.json.jobPostings.map((j) => {
        const loc = normLoc([j.locationsText, j.location].filter(Boolean).join(" · "));
        return {
          external_id: j.id || j.externalPath,
          url: `${wdBase}${j.externalPath || ""}`,
          title: j.title,
          department: j.jobFamilyGroup || j.jobFamily || null,
          team: null,
          location: loc.location,
          remote_policy: loc.remote_policy,
          employment_type: inferEmploymentType(j.timeType, j.title, ""),
          posted_at: j.startDate || j.postedOn || null,
          description: null,
          description_text: null,
          raw: { source: "workday", bulletFields: j.bulletFields, externalPath: j.externalPath },
        };
      });
      return { ok: true, items };
    }
  }
  // Fallback: HTML crawl
  const html = await fetchJson(careersUrl, { headers: { accept: "text/html" } });
  if (!html.ok) return { ok: false, error: `workday_http_${html.status}` };
  const links = extractJobLinks(html.text, careersUrl);
  return {
    ok: true,
    items: links.map((l) => ({
      external_id: l.id || l.url,
      url: l.url,
      title: l.title,
      department: null,
      team: null,
      location: null,
      remote_policy: "unknown",
      employment_type: null,
      posted_at: null,
      description: null,
      description_text: null,
      raw: { source: "workday_html", href: l.href },
    })),
  };
}

// ── Generic HTML ──────────────────────────────────────────────────
export async function scrapeHtml(careersUrl, ctx) {
  const r = await fetchJson(careersUrl, { headers: { accept: "text/html" } });
  if (!r.ok) return { ok: false, error: `html_http_${r.status}` };
  const links = extractJobLinks(r.text, careersUrl);
  return {
    ok: true,
    items: links.map((l) => ({
      external_id: l.id || l.url,
      url: l.url,
      title: l.title,
      department: null,
      team: null,
      location: null,
      remote_policy: "unknown",
      employment_type: null,
      posted_at: null,
      description: null,
      description_text: null,
      raw: { source: "html", href: l.href },
    })),
  };
}

// ── HTML parsing helpers ──────────────────────────────────────────
// We extract <a href=...>Job Title</a> patterns where href looks like
// a job URL (has /job, /jobs, /position, /posting, /careers/, ends in
// a number, etc.). Keeps regex conservative to avoid false positives.

function extractJobLinks(html, baseUrl) {
  const out = [];
  const seen = new Set();
  const re = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([^<]{3,140})<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    let href = m[1].trim();
    let title = stripTagsAndEntities(m[2]).trim();
    if (!title || title.length < 3) continue;
    if (looksLikeNav(href, title)) continue;
    if (!looksLikeJob(href, title)) continue;
    let abs;
    try { abs = new URL(href, baseUrl).toString(); }
    catch { continue; }
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push({ id: null, url: abs, title, href });
  }
  return out;
}

function looksLikeJob(href, title) {
  const h = href.toLowerCase();
  const t = title.toLowerCase();
  if (/\b(job|jobs|career|careers|position|positions|posting|postings|opening|openings|role|roles)\b/.test(h)) return true;
  if (/(\/job|\/jobs|\/position|\/posting|\/opening|\/role|\/career|\/careers|\/apply)/.test(h)) return true;
  // Common words in titles
  if (/\b(engineer|developer|architect|manager|director|analyst|scientist|designer|associate|consultant|specialist|lead|head of|vp|officer|intern)\b/.test(t)) {
    // And the href isn't just a section anchor or homepage
    if (h.length > 12) return true;
  }
  return false;
}

function looksLikeNav(href, title) {
  const t = title.toLowerCase();
  if (/^(home|about|contact|login|sign in|careers?|search|menu|skip|privacy|terms|cookie|legal|blog|news|press|locations|benefits|culture|team|values|missions?|locations)$/.test(t)) return true;
  if (/^(privacy policy|terms of (use|service)|cookie (policy|preferences))$/.test(t)) return true;
  return false;
}

function stripTagsAndEntities(s) {
  return String(s).replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'");
}

function stripHtml(html) {
  if (!html) return null;
  return stripTagsAndEntities(html).replace(/\s+/g, " ").slice(0, 8000);
}

// ── Dispatcher ────────────────────────────────────────────────────
export async function scrapeCompany(company, ctx) {
  const { careers_kind, careers_handle, careers_url } = company;
  switch (careers_kind) {
    case "greenhouse":      return scrapeGreenhouse(careers_handle, ctx);
    case "lever":           return scrapeLever(careers_handle, ctx);
    case "ashby":           return scrapeAshby(careers_handle, ctx);
    case "smartrecruiters": return scrapeSmartRecruiters(careers_handle, ctx);
    case "workday":         return scrapeWorkday(careers_url, careers_handle, ctx);
    case "html":            return scrapeHtml(careers_url, ctx);
    case "linkedin":        return { ok: false, error: "linkedin_skipped" };
    case "unknown":
    default:
      // Last-ditch HTML scrape
      return scrapeHtml(careers_url, ctx);
  }
}
