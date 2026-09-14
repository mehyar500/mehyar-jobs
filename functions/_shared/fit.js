// _shared/fit.js
//
// Deterministic fit-score engine. Pure functions, easy to test.
//
// Inputs: a normalized job row + the user's profile row.
// Output: { score: 0-100, reasons: [...], hard_no: 0|1, hard_no_reason }
//
// Scoring model (out of 100):
//   +50  title matches a target_title (or close synonym)
//   +20  description contains >=2 of the user's keywords
//   +10  description contains >=1 of the user's keywords
//   +10  location contains a preferred location OR remote
//    -25 hard no: salary below min, location not in list, exclude keyword match,
//                excluded industry
//    +5   industry preferred bonus
//    +5   recent posting bonus (posted within last 14 days)
//
// hard_no filter is applied AFTER computing the score (so the user sees
// the score of the job they were filtered out of, in case they want to
// reconsider).

const SYNONYMS = {
  "ai engineer": ["ml engineer", "llm engineer", "applied ai", "prompt engineer", "ai/ml engineer", "machine learning engineer"],
  "staff engineer": ["principal engineer", "distinguished engineer", "staff software engineer", "senior staff engineer"],
  "engineering manager": ["eng manager", "engineering lead", "manager, engineering", "head of engineering"],
  "product manager": ["pm", "product owner", "group product manager"],
  "data scientist": ["research scientist, ml", "applied scientist"],
  "designer": ["product designer", "ux designer", "ui designer", "design engineer"],
  "founder": ["co-founder", "founding engineer", "founding member"],
};

function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9+\- ]+/g, " ").replace(/\s+/g, " ").trim();
}

function expandSynonyms(phrase) {
  const p = norm(phrase);
  const list = [p, ...(SYNONYMS[p] || []).map(norm)];
  return list;
}

function titleMatchScore(jobTitle, targetTitles) {
  const t = norm(jobTitle);
  for (const tt of targetTitles || []) {
    for (const v of expandSynonyms(tt)) {
      if (!v) continue;
      if (t === v) return { score: 50, matched: tt, how: "exact" };
      if (t.includes(v) || v.includes(t)) return { score: 40, matched: tt, how: "close" };
      // Token overlap fallback
      const ttTokens = new Set(v.split(" "));
      const jobTokens = new Set(t.split(" "));
      const intersect = [...ttTokens].filter((x) => jobTokens.has(x));
      if (intersect.length >= Math.min(2, ttTokens.size)) return { score: 30, matched: tt, how: "partial" };
    }
  }
  return { score: 0, matched: null, how: null };
}

function keywordScore(text, keywords) {
  if (!text || !keywords?.length) return { score: 0, hits: [] };
  const t = norm(text);
  const hits = [];
  for (const k of keywords) {
    const kn = norm(k);
    if (kn && t.includes(kn)) hits.push(k);
  }
  if (hits.length >= 2) return { score: 20, hits };
  if (hits.length >= 1) return { score: 10, hits };
  return { score: 0, hits: [] };
}

function locationScore(loc, remotePolicy, prefs, remoteRequired) {
  if (remoteRequired) {
    if (remotePolicy === "remote") return { score: 10, note: "remote — matches your requirement" };
    if (remotePolicy === "hybrid") return { score: 4, note: "hybrid (you asked for remote)" };
    return { score: 0, note: null };
  }
  if (!loc || !prefs?.length) return { score: 0, note: null };
  const l = norm(loc);
  for (const p of prefs) {
    const pn = norm(p);
    if (!pn) continue;
    if (pn === "remote" && remotePolicy === "remote") return { score: 10, note: "remote — matches your preference" };
    if (l.includes(pn) || pn.includes(l)) return { score: 10, note: `location “${p}” matches` };
  }
  return { score: 0, note: null };
}

function salaryScore(min, max, floorUsd) {
  if (!floorUsd) return 0;
  const cap = Number(min) || Number(max) || 0;
  if (!cap) return 0;
  if (cap >= floorUsd) return 5;
  // Partial: 50% credit if within 15% of floor
  if (cap >= floorUsd * 0.85) return 3;
  return -10;
}

function recentBonus(postedAt) {
  if (!postedAt) return 0;
  const t = Date.parse(postedAt);
  if (!Number.isFinite(t)) return 0;
  const days = (Date.now() - t) / 86400000;
  if (days <= 14) return 5;
  if (days <= 30) return 2;
  return 0;
}

function hardNoCheck(job, profile, industry) {
  if (!profile) return { hard_no: 0, reason: null };
  // Exclude keywords in title/description
  const text = norm(`${job.title || ""} ${job.description_text || ""}`);
  for (const k of profile.exclude_keywords || []) {
    if (k && text.includes(norm(k))) {
      return { hard_no: 1, reason: `excluded keyword: ${k}` };
    }
  }
  // Excluded industries
  if (industry && (profile.excluded_industries || []).some((i) => norm(i) === norm(industry))) {
    return { hard_no: 1, reason: `excluded industry: ${industry}` };
  }
  // Required remote
  if (profile.remote_required && job.remote_policy !== "remote") {
    return { hard_no: 1, reason: "remote required" };
  }
  // Min salary
  if (profile.min_salary_usd && (job.salary_min || job.salary_max) && Math.max(job.salary_min || 0, job.salary_max || 0) < profile.min_salary_usd * 0.85) {
    return { hard_no: 1, reason: `salary below ${profile.min_salary_usd}` };
  }
  return { hard_no: 0, reason: null };
}

export function scoreJob(job, profile, industry) {
  const reasons = [];
  const explain = [];
  let score = 0;

  const titleRes = titleMatchScore(job.title, profile?.target_titles || []);
  if (titleRes.score) {
    score += titleRes.score;
    reasons.push(`title match +${titleRes.score}`);
    const howWord = titleRes.how === "exact" ? "exactly matches" : titleRes.how === "close" ? "closely matches" : "partly matches";
    explain.push(`✓ Title ${howWord} your target “${titleRes.matched}” (+${titleRes.score})`);
  }

  const kwRes = keywordScore(`${job.title || ""} ${job.description_text || ""}`, profile?.keywords || []);
  if (kwRes.score) {
    score += kwRes.score;
    reasons.push(`keywords +${kwRes.score}`);
    const shown = kwRes.hits.slice(0, 6).join(", ");
    explain.push(`✓ ${kwRes.hits.length} of your skills in the posting: ${shown}${kwRes.hits.length > 6 ? "…" : ""} (+${kwRes.score})`);
  }

  const locRes = locationScore(job.location, job.remote_policy, profile?.locations, profile?.remote_required);
  if (locRes.score) {
    score += locRes.score;
    reasons.push(`location/remote +${locRes.score}`);
    explain.push(`✓ ${locRes.note} (+${locRes.score})`);
  }

  const salScore = salaryScore(job.salary_min, job.salary_max, profile?.min_salary_usd);
  if (salScore > 0) {
    score += salScore; reasons.push(`salary +${salScore}`);
    explain.push(`✓ Salary clears your floor (+${salScore})`);
  }
  if (salScore < 0) {
    score += salScore; reasons.push(`salary below floor ${salScore}`);
    explain.push(`⚠ Salary looks below your floor (${salScore})`);
  }

  const rec = recentBonus(job.posted_at);
  if (rec) {
    score += rec; reasons.push(`recent +${rec}`);
    explain.push(`✓ Posted recently — fresh listing (+${rec})`);
  }

  if (industry && (profile?.preferred_industries || []).some((i) => norm(i) === norm(industry))) {
    score += 5; reasons.push(`preferred industry +5`);
    explain.push(`✓ Preferred industry: ${industry} (+5)`);
  }

  // Floor + clamp
  score = Math.max(0, Math.min(100, Math.round(score)));

  const hard = hardNoCheck(job, profile, industry);
  if (hard.hard_no) {
    reasons.push(`hard no: ${hard.reason}`);
    explain.push(`⛔ Excluded: ${hard.reason}`);
  }

  return { score, reasons, explain, hard_no: hard.hard_no, hard_no_reason: hard.reason };
}

export async function loadProfile(arg) {
  // Accept either an env (with JOBS_DB) or a pre-fetched row.
  let row = null;
  if (arg && arg.JOBS_DB) {
    row = await arg.JOBS_DB.prepare("SELECT * FROM profile WHERE id = 1").first();
  } else {
    row = arg;
  }
  if (!row) return null;
  return {
    full_name:        row.full_name || "",
    email:            row.email || "",
    target_titles: safeJson(row.target_titles_json, []),
    keywords: safeJson(row.keywords_json, []),
    exclude_keywords: safeJson(row.exclude_keywords_json, []),
    locations: safeJson(row.locations_json, []),
    remote_required: !!row.remote_required,
    min_salary_usd: row.min_salary_usd || null,
    preferred_industries: safeJson(row.preferred_industries_json, []),
    excluded_industries: safeJson(row.excluded_industries_json, []),
    notes: row.notes || "",
    // New fields for the headless auto-submit + cover-letter generator
    resume_base64:    row.resume_base64 || "",
    resume_filename:  row.resume_filename || "",
    resume_mime:      row.resume_mime || "",
    resume_text:      row.resume_text || "",
    linkedin_url:     row.linkedin_url || "",
    github_url:       row.github_url || "",
    portfolio_url:    row.portfolio_url || "",
    personal_website: row.personal_website || "",
    phone:            row.phone || "",
    city:             row.city || "",
    country:          row.country || "",
    work_auth:        row.work_auth || "",
    years_experience: row.years_experience || null,
    current_title:    row.current_title || "",
    current_company:  row.current_company || "",
    current_salary:   row.current_salary || null,
    notice_period:    row.notice_period || "",
    gender:           row.gender || "",
    ethnicity:        row.ethnicity || "",
    veteran_status:   row.veteran_status || "",
    disability:       row.disability || "",
    hispanic_latino:  row.hispanic_latino || "",
    cleartext_address: row.cleartext_address || "",
    default_answers:  safeJson(row.default_answers_json, {}),
  };
}

function safeJson(s, fb) {
  if (!s) return fb;
  try { return JSON.parse(s); } catch { return fb; }
}

// ── Name split helper ──
// Splits a full name into first + last. Works for "Mehyar Swelim",
// "Mehyar A. Swelim", "Mehyar bin Swelim" (treats first token as first name).
export function splitName(full) {
  const f = String(full || "").trim().split(/\s+/).filter(Boolean);
  if (f.length === 0) return { first: "", last: "" };
  if (f.length === 1) return { first: f[0], last: "" };
  return { first: f[0], last: f.slice(1).join(" ") };
}

// ── Look up first/last from profile.full_name (or first_name/last_name) ──
export function getProfileNames(profile) {
  if (!profile) return { first: "", last: "" };
  if (profile.first_name || profile.last_name) {
    return { first: profile.first_name || "", last: profile.last_name || "" };
  }
  return splitName(profile.full_name);
}
