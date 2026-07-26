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
      if (t === v) return 50;
      if (t.includes(v) || v.includes(t)) return 40;
      // Token overlap fallback
      const ttTokens = new Set(v.split(" "));
      const jobTokens = new Set(t.split(" "));
      const intersect = [...ttTokens].filter((x) => jobTokens.has(x));
      if (intersect.length >= Math.min(2, ttTokens.size)) return 30;
    }
  }
  return 0;
}

function keywordScore(text, keywords) {
  if (!text || !keywords?.length) return 0;
  const t = norm(text);
  let hits = 0;
  for (const k of keywords) {
    const kn = norm(k);
    if (kn && t.includes(kn)) hits += 1;
  }
  if (hits >= 2) return 20;
  if (hits >= 1) return 10;
  return 0;
}

function locationScore(loc, remotePolicy, prefs, remoteRequired) {
  if (remoteRequired) {
    if (remotePolicy === "remote") return 10;
    if (remotePolicy === "hybrid") return 4;
    return 0;
  }
  if (!loc || !prefs?.length) return 0;
  const l = norm(loc);
  for (const p of prefs) {
    const pn = norm(p);
    if (!pn) continue;
    if (pn === "remote" && remotePolicy === "remote") return 10;
    if (l.includes(pn) || pn.includes(l)) return 10;
  }
  return 0;
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
  let score = 0;

  const titleScore = titleMatchScore(job.title, profile?.target_titles || []);
  if (titleScore) { score += titleScore; reasons.push(`title match +${titleScore}`); }

  const kwScore = keywordScore(`${job.title || ""} ${job.description_text || ""}`, profile?.keywords || []);
  if (kwScore) { score += kwScore; reasons.push(`keywords +${kwScore}`); }

  const locScore = locationScore(job.location, job.remote_policy, profile?.locations, profile?.remote_required);
  if (locScore) { score += locScore; reasons.push(`location/remote +${locScore}`); }

  const salScore = salaryScore(job.salary_min, job.salary_max, profile?.min_salary_usd);
  if (salScore > 0) { score += salScore; reasons.push(`salary +${salScore}`); }
  if (salScore < 0) { score += salScore; reasons.push(`salary below floor ${salScore}`); }

  const rec = recentBonus(job.posted_at);
  if (rec) { score += rec; reasons.push(`recent +${rec}`); }

  if (industry && (profile?.preferred_industries || []).some((i) => norm(i) === norm(industry))) {
    score += 5; reasons.push(`preferred industry +5`);
  }

  // Floor + clamp
  score = Math.max(0, Math.min(100, Math.round(score)));

  const hard = hardNoCheck(job, profile, industry);
  if (hard.hard_no) {
    reasons.push(`hard no: ${hard.reason}`);
  }

  return { score, reasons, hard_no: hard.hard_no, hard_no_reason: hard.reason };
}

export function loadProfile(row) {
  if (!row) return null;
  return {
    target_titles: safeJson(row.target_titles_json, []),
    keywords: safeJson(row.keywords_json, []),
    exclude_keywords: safeJson(row.exclude_keywords_json, []),
    locations: safeJson(row.locations_json, []),
    remote_required: !!row.remote_required,
    min_salary_usd: row.min_salary_usd || null,
    preferred_industries: safeJson(row.preferred_industries_json, []),
    excluded_industries: safeJson(row.excluded_industries_json, []),
    notes: row.notes || "",
  };
}

function safeJson(s, fb) {
  if (!s) return fb;
  try { return JSON.parse(s); } catch { return fb; }
}