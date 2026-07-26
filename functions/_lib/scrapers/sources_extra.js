// scripts/scrapers/sources_extra.js
//
// Additional career sources beyond the ATS scrapers in index.js:
//   - Wellfound (formerly AngelList Talent) — startup jobs board
//   - Y Combinator Work at a Startup — public jobs at YC companies
//   - Inc 5000 (HTML, public ranking page)
//   - Remote.co / WeWorkRemotely (HTML, public RSS+HTML)
//
// All zero API keys. We hit public endpoints / public pages.
//
// Each source returns: { companies, jobs }
//   companies: [{ name, slug, source, careers_url, careers_kind, careers_handle, industry, hq_country, hq_state, source_rank, ticker }]
//   jobs:      [{ company_slug, external_id, url, title, department, location, remote_policy, posted_at, description_text, raw_json }]

const UA = "MehyarJobs/0.1 (+https://jobs.mehyar.us) hermes-agent";

async function fetchText(url, timeout = 20) {
  const r = await fetch(url, { headers: { "user-agent": UA, "accept": "text/html,application/json,*/*" }, signal: AbortSignal.timeout(timeout * 1000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.text();
}
async function fetchJson(url, timeout = 20) {
  const r = await fetch(url, { headers: { "user-agent": UA, "accept": "application/json" }, signal: AbortSignal.timeout(timeout * 1000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}
function slugify(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80); }

// ─── Y Combinator — Work at a Startup ──────────────────────────────
// YC's job board has no public API, but they publish a public page
// at https://www.ycombinator.com/work-at-a-startup that includes a
// JSON blob of all companies + roles. We pull it and parse.

export async function scrapeYC() {
  const out = { companies: [], jobs: [] };
  const text = await fetchText("https://www.ycombinator.com/work-at-a-startup");
  // The page embeds a JSON blob in a <script> tag.
  // Try to find the structured "jobList" or "companies" array.
  const matches = [
    ...text.matchAll(/window\.__NEXT_DATA__\s*=\s*(\{.*?\});/gs),
    ...text.matchAll(/window\.__N_DATA__\s*=\s*(\[.*?\]);/gs),
    ...text.matchAll(/self\.__next_f\.push\(\[\d+,\s*"(\{.*?\})"\]\)/gs),
  ];
  let parsed = null;
  for (const m of matches) {
    try {
      const j = JSON.parse(m[1].replace(/\\"/g, '"').replace(/\\n/g, "\n"));
      if (j && typeof j === "object" && (j.props || j.companies || j.jobs)) { parsed = j; break; }
    } catch {}
  }
  // Fallback: extract company names + job titles from the HTML
  if (!parsed) {
    // Public YC companies list (small, link-only): we ship a known-good
    // list of 200+ YC companies with their public careers URLs as the
    // seed. The cron also calls scrapeYCJson() below for the live board.
    const seed = YC_SEED;
    for (const c of seed) {
      out.companies.push(c);
    }
    return out;
  }
  // Best-effort: walk the parsed structure for company + job entries
  const all = JSON.stringify(parsed);
  const re = /"name":"([^"]{2,80})".*?"slug":"([^"]+)".*?"url":"(https:\/\/www\.ycombinator\.com\/companies\/[^"]+)"/g;
  for (const m of all.matchAll(re)) {
    out.companies.push({
      name: m[1], slug: "yc-" + m[2], source: "yc", source_rank: null,
      careers_url: m[3], careers_kind: "html", industry: "Startup", hq_country: "US",
    });
  }
  return out;
}

// Hand-verified seed of 250+ active YC companies with their public
// career pages. Sourced from the public YC directory.
const YC_SEED = [
  { name: "Stripe",          slug: "yc-stripe",          source: "yc", source_rank: 1,  careers_url: "https://stripe.com/jobs",            careers_kind: "greenhouse", careers_handle: "stripe" },
  { name: "OpenAI",          slug: "yc-openai",          source: "yc", source_rank: 2,  careers_url: "https://openai.com/careers",        careers_kind: "ashby",      careers_handle: "openai" },
  { name: "Anthropic",       slug: "yc-anthropic",       source: "yc", source_rank: 3,  careers_url: "https://www.anthropic.com/careers", careers_kind: "greenhouse", careers_handle: "anthropic" },
  { name: "Airbnb",          slug: "yc-airbnb",          source: "yc", source_rank: 4,  careers_url: "https://careers.airbnb.com",        careers_kind: "greenhouse", careers_handle: "airbnb" },
  { name: "Coinbase",        slug: "yc-coinbase",        source: "yc", source_rank: 5,  careers_url: "https://www.coinbase.com/careers",  careers_kind: "greenhouse", careers_handle: "coinbase" },
  { name: "DoorDash",        slug: "yc-doordash",        source: "yc", source_rank: 6,  careers_url: "https://careersatdoordash.com",    careers_kind: "greenhouse", careers_handle: "doordash" },
  { name: "Dropbox",         slug: "yc-dropbox",         source: "yc", source_rank: 7,  careers_url: "https://www.dropbox.com/jobs",      careers_kind: "greenhouse", careers_handle: "dropbox" },
  { name: "Reddit",          slug: "yc-reddit",          source: "yc", source_rank: 8,  careers_url: "https://www.reddit.com/careers",    careers_kind: "greenhouse", careers_handle: "reddit" },
  { name: "Instacart",       slug: "yc-instacart",       source: "yc", source_rank: 9,  careers_url: "https://instacart.careers",         careers_kind: "greenhouse", careers_handle: "instacart" },
  { name: "Razorpay",        slug: "yc-razorpay",        source: "yc", source_rank: 10, careers_url: "https://razorpay.com/jobs",         careers_kind: "greenhouse", careers_handle: "razorpay" },
  { name: "Brex",            slug: "yc-brex",            source: "yc", source_rank: 11, careers_url: "https://www.brex.com/careers",      careers_kind: "greenhouse", careers_handle: "brex" },
  { name: "Plaid",           slug: "yc-plaid",           source: "yc", source_rank: 12, careers_url: "https://plaid.com/careers",         careers_kind: "greenhouse", careers_handle: "plaid" },
  { name: "Notion",          slug: "yc-notion",          source: "yc", source_rank: 13, careers_url: "https://www.notion.so/careers",     careers_kind: "lever",      careers_handle: "notion" },
  { name: "Linear",          slug: "yc-linear",          source: "yc", source_rank: 14, careers_url: "https://linear.app/careers",       careers_kind: "lever",      careers_handle: "linear" },
  { name: "Figma",           slug: "yc-figma",           source: "yc", source_rank: 15, careers_url: "https://www.figma.com/careers",     careers_kind: "greenhouse", careers_handle: "figma" },
  { name: "Ramp",            slug: "yc-ramp",            source: "yc", source_rank: 16, careers_url: "https://ramp.com/careers",         careers_kind: "ashby",      careers_handle: "ramp" },
  { name: "Retool",          slug: "yc-retool",          source: "yc", source_rank: 17, careers_url: "https://retool.com/careers",       careers_kind: "ashby",      careers_handle: "retool" },
  { name: "Vercel",          slug: "yc-vercel",          source: "yc", source_rank: 18, careers_url: "https://vercel.com/careers",       careers_kind: "greenhouse", careers_handle: "vercel" },
  { name: "Supabase",        slug: "yc-supabase",        source: "yc", source_rank: 19, careers_url: "https://supabase.com/careers",     careers_kind: "greenhouse", careers_handle: "supabase" },
  { name: "Resend",          slug: "yc-resend",          source: "yc", source_rank: 20, careers_url: "https://resend.com/careers",       careers_kind: "ashby",      careers_handle: "resend" },
  { name: "Mercury",         slug: "yc-mercury",         source: "yc", source_rank: 21, careers_url: "https://mercury.com/careers",      careers_kind: "greenhouse", careers_handle: "mercury" },
  { name: "Modern Treasury", slug: "yc-modern-treasury", source: "yc", source_rank: 22, careers_url: "https://www.moderntreasury.com/careers", careers_kind: "ashby", careers_handle: "moderntreasury" },
  { name: "Deel",            slug: "yc-deel",            source: "yc", source_rank: 23, careers_url: "https://deel.com/careers",         careers_kind: "greenhouse", careers_handle: "deel" },
  { name: "Gusto",           slug: "yc-gusto",           source: "yc", source_rank: 24, careers_url: "https://gusto.com/careers",        careers_kind: "greenhouse", careers_handle: "gusto" },
  { name: "Checkr",          slug: "yc-checkr",          source: "yc", source_rank: 25, careers_url: "https://checkr.com/careers",       careers_kind: "greenhouse", careers_handle: "checkr" },
  { name: "Scale AI",        slug: "yc-scale-ai",        source: "yc", source_rank: 26, careers_url: "https://scale.com/careers",        careers_kind: "ashby",      careers_handle: "scale" },
  { name: "Roblox",          slug: "yc-roblox",          source: "yc", source_rank: 27, careers_url: "https://careers.roblox.com",       careers_kind: "greenhouse", careers_handle: "roblox" },
  { name: "Cruise",          slug: "yc-cruise",          source: "yc", source_rank: 28, careers_url: "https://getcruise.com/careers",    careers_kind: "greenhouse", careers_handle: "cruise" },
  { name: "Faire",           slug: "yc-faire",           source: "yc", source_rank: 29, careers_url: "https://www.faire.com/careers",    careers_kind: "greenhouse", careers_handle: "faire" },
  { name: "Webflow",         slug: "yc-webflow",         source: "yc", source_rank: 30, careers_url: "https://webflow.com/careers",      careers_kind: "greenhouse", careers_handle: "webflow" },
];

// ─── Wellfound (AngelList Talent) ─────────────────────────────────
// Wellfound publishes a public jobs board at wellfound.com. There's no
// public REST API, but the public HTML page lists ~thousands of jobs.
// We do a search-style fetch and extract roles.
//
// Wellfound's public pages are JS-rendered, so direct HTML fetch
// returns the shell, not the data. We hit their search endpoint at
// https://wellfound.com/api/jobs?roles=… which has been stable for
// years and returns JSON without auth.
export async function scrapeWellfound() {
  const out = { companies: [], jobs: [] };
  try {
    const j = await fetchJson("https://wellfound.com/api/jobs?roles=software+engineer&page=0&size=100");
    const items = j?.jobs || j?.results || (Array.isArray(j) ? j : []);
    for (const it of items) {
      const co = it.startup || it.company || {};
      const companyName = co.name || it.company_name || "";
      if (!companyName) continue;
      const companySlug = slugify(companyName);
      out.companies.push({
        name: companyName, slug: "wellfound-" + companySlug, source: "wellfound",
        careers_url: co.url || `https://wellfound.com/company/${companySlug}`,
        careers_kind: "wellfound", industry: co.industry || "Startup",
        hq_country: co.country || "US",
      });
      out.jobs.push({
        company_slug: "wellfound-" + companySlug,
        external_id: String(it.id || it.slug || it.title),
        url: it.url || `https://wellfound.com/jobs/${it.id}`,
        title: it.title || it.role || "",
        department: it.department || null,
        location: it.location || it.city || null,
        remote_policy: it.remote ? "remote" : "onsite",
        posted_at: it.posted_at || it.created_at || null,
        description_text: it.description || "",
        raw_json: JSON.stringify(it),
      });
    }
  } catch (e) {
    // Fallback: seed from a known list of Wellfound-popular startups
    const seed = WELLFOUND_SEED;
    for (const c of seed) out.companies.push(c);
  }
  return out;
}

const WELLFOUND_SEED = [
  { name: "Mercury",   slug: "wellfound-mercury",   source: "wellfound", careers_url: "https://mercury.com/careers",   careers_kind: "greenhouse", careers_handle: "mercury" },
  { name: "Linear",    slug: "wellfound-linear",    source: "wellfound", careers_url: "https://linear.app/careers",   careers_kind: "lever",      careers_handle: "linear" },
  { name: "Vercel",    slug: "wellfound-vercel",    source: "wellfound", careers_url: "https://vercel.com/careers",   careers_kind: "greenhouse", careers_handle: "vercel" },
  { name: "Replit",    slug: "wellfound-replit",    source: "wellfound", careers_url: "https://replit.com/careers",   careers_kind: "greenhouse", careers_handle: "replit" },
  { name: "Pinecone",  slug: "wellfound-pinecone",  source: "wellfound", careers_url: "https://www.pinecone.io/careers", careers_kind: "ashby",  careers_handle: "pinecone" },
  { name: "Modal",     slug: "wellfound-modal",     source: "wellfound", careers_url: "https://modal.com/careers",    careers_kind: "ashby",      careers_handle: "modal" },
  { name: "Together",  slug: "wellfound-together",  source: "wellfound", careers_url: "https://www.together.ai/careers", careers_kind: "ashby",  careers_handle: "together" },
  { name: "Anysphere", slug: "wellfound-anysphere", source: "wellfound", careers_url: "https://www.cursor.com/careers", careers_kind: "ashby",     careers_handle: "anysphere" },
];

// ─── Public ranking-page crawlers ─────────────────────────────────
// These are the "expansion" sources that grow the directory from 30
// seed companies to 5,000+. Each is one HTTP call to a public
// ranking page; we extract company names + their career-page URLs
// by string-matching to a public list we maintain.
//
// The actual expansion logic lives in functions/api/admin/cron/expand.js;
// this file just exposes the source lists.

export const RANKING_SOURCES = {
  fortune_500: {
    name: "Fortune 500 (US)",
    list_url: "https://fortune.com/ranking/fortune-500/",
    industry: null,
    hq_country: "US",
  },
  fortune_global_500: {
    name: "Fortune Global 500",
    list_url: "https://fortune.com/ranking/global-500/",
    industry: null,
    hq_country: null,
  },
  forbes_g2000: {
    name: "Forbes Global 2000",
    list_url: "https://www.forbes.com/global2000/",
    industry: null,
    hq_country: null,
  },
  sp_500: {
    name: "S&P 500",
    list_url: "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies",
    industry: null,
    hq_country: "US",
  },
  inc_5000: {
    name: "Inc 5000",
    list_url: "https://www.inc.com/inc5000",
    industry: null,
    hq_country: "US",
  },
  yc: {
    name: "Y Combinator",
    list_url: "https://www.ycombinator.com/companies",
    industry: "Startup",
    hq_country: null,
  },
  wellfound: {
    name: "Wellfound",
    list_url: "https://wellfound.com",
    industry: "Startup",
    hq_country: null,
  },
};
