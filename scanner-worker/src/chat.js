// scanner-worker/src/chat.js
//
// AI job-search chat (Workers AI + D1):
//   POST /chat — conversational assistant that searches the live jobs DB,
//   fit-scores matches, and answers with links + scores.
//
// Auth is OPTIONAL: members get 30 chat messages/day, anonymous visitors
// (salted IP hash) get 5/day. Everything is free — limits exist only to
// prevent abuse.

import { requireUser, deriveProfileFromResume, getUserFitProfile } from "../../functions/_shared/userAuth.js";
import { ensureSchema } from "../../functions/_shared/db.js";
import { scoreJob } from "../../functions/_shared/fit.js";
import { clientIpHash, anonUsage, recordAnonUse } from "../../functions/_shared/anonGate.js";

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";
const MEMBER_CHAT_PER_DAY = 30;
const ANON_CHAT_PER_DAY = 5;
const MAX_MESSAGE_CHARS = 2000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function corsJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

const CHAT_STOP = new Set(
  "a,an,the,and,or,of,to,in,on,for,with,at,by,from,as,is,are,was,were,be,been,have,has,had,do,does,did,will,would,can,could,should,may,might,this,that,these,those,it,its,i,me,my,we,our,you,your,he,she,they,their,not,no,yes,if,then,than,so,such,into,over,under,between,through,during,including,etc,via,per,within,across,using,used,use,based,driven,led,lead,managed,built,developed,designed,implemented,created,improved,increased,reduced,experience,experienced,skills,summary,looking,seeking,find,search,show,give,tell,about,what,which,there,their,job,jobs,role,roles,position,positions,work,working,want,need,like,good,best,any,some,more,most,all,hiring,open,opening,openings,career,careers,company,companies,near,close".split(",")
);

function extractTerms(text, limit = 8) {
  const counts = new Map();
  for (const raw of String(text || "").toLowerCase().split(/[^a-z0-9+#.\-]{1,}/)) {
    const t = raw.replace(/^[#.\-]+|[#.\-]+$/g, "");
    if (t.length < 3 || t.length > 30 || CHAT_STOP.has(t) || /^\d+$/.test(t)) continue;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([t]) => t);
}

function detectIntent(text) {
  const t = String(text || "").toLowerCase();
  return {
    remote: /\bremote\b|work from home|\bwfh\b/.test(t),
    contract: /\bcontract\b|\bfreelance\b|1099/.test(t),
    fullTime: /full.?time|\bw-?2\b/.test(t),
    wantsJob: /\b(job|jobs|role|roles|position|positions|hiring|opening|openings|career|careers|gig|work)\b/.test(t),
    greeting: /^(hi|hey|hello|yo|sup|thanks|thank you|ok|okay|cool|great)\b[\s!.]*$/i.test(t.trim()),
    // ATS Mirror: user wants their resume audited against applicant tracking systems.
    wantsAts: /\bats\b|applicant tracking|resume (audit|review|check|score|critique|feedback)|check my resume|audit my resume|how.*resume.*look|mirror/.test(t),
  };
}

async function resolveChatIdentity(request, env) {
  await ensureSchema(env);
  const db = env.JOBS_DB;
  const auth = await requireUser(request, env).catch(() => ({ ok: false }));
  if (auth?.ok && auth.user) {
    const key = `user:${auth.user.id}`;
    const usage = await anonUsage(db, key, "chat");
    if (usage.usedToday >= MEMBER_CHAT_PER_DAY) {
      // Referral bonus: burn one earned bonus credit instead of rejecting.
      const bonus = await db.prepare(
        "UPDATE app_user SET chat_bonus_credits = chat_bonus_credits - 1 WHERE id = ? AND chat_bonus_credits > 0"
      ).bind(auth.user.id).run().catch(() => null);
      if (bonus && bonus.meta && bonus.meta.changes > 0) {
        return { ok: true, user: auth.user, gateKey: key, remaining: 0, bonus_used: true };
      }
      return { ok: false, status: 429, error: "chat_limit", message: "You've used your 30 chats for today — back tomorrow. Invite friends to earn bonus chats!" };
    }
    return { ok: true, user: auth.user, gateKey: key, remaining: MEMBER_CHAT_PER_DAY - usage.usedToday, bonus_used: false };
  }
  const ipHash = await clientIpHash(request, env);
  const usage = await anonUsage(db, ipHash, "chat");
  if (usage.usedToday >= ANON_CHAT_PER_DAY) {
    return {
      ok: false, status: 429, error: "chat_limit",
      message: "That's 5 chats today — create a free account for 30 a day, plus unlimited fit checks.",
    };
  }
  return { ok: true, user: null, gateKey: ipHash, remaining: ANON_CHAT_PER_DAY - usage.usedToday };
}

// Light stemming so "nursing" matches "nurse", "engineers" matches "engineer".
function stems(t) {
  const out = new Set([t]);
  if (t.endsWith("ing") && t.length > 5) out.add(t.slice(0, -3));
  if (t.endsWith("ies") && t.length > 4) out.add(t.slice(0, -3) + "y");
  else if (t.endsWith("es") && t.length > 4) out.add(t.slice(0, -2));
  else if (t.endsWith("s") && t.length > 4) out.add(t.slice(0, -1));
  return [...out];
}

// Pull a target job title out of the user's message ("remote software
// engineer jobs" -> "Software Engineer") so fit.js title matching works.
const CHAT_TITLE_HINTS = new Set(
  "engineer,developer,designer,nurse,manager,analyst,accountant,technician,driver,assistant,specialist,consultant,architect,scientist,therapist,teacher,clerk,chef,mechanic,electrician,plumber,carpenter,welder,sales,marketing,support,administrator,coordinator,director,lead,supervisor,representative,associate,intern,developer,devops,data,security,product,project".split(",")
);
const TITLE_FILLER = new Set("a,an,the,for,and,or,me,my,find,looking,seeking,search,searching,show,give,get,want,need,any,some,jobs,job,roles,role,positions,position,openings,open,hiring,near,remote,hybrid,onsite,site,entry".split(","));
function singularish(w) {
  if (CHAT_TITLE_HINTS.has(w)) return w;
  if (w.endsWith("ing") && CHAT_TITLE_HINTS.has(w.slice(0, -3) + "e")) return w.slice(0, -3) + "e"; // nursing -> nurse
  if (w.endsWith("s") && CHAT_TITLE_HINTS.has(w.slice(0, -1))) return w.slice(0, -1);
  return null;
}
function extractTitlesFromMessage(text) {
  const words = String(text || "").toLowerCase().split(/[^a-z0-9+#]+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const sing = singularish(words[i]);
    if (!sing) continue;
    const win = [];
    for (let j = i; j >= Math.max(0, i - 2) && win.length < 3; j--) {
      if (TITLE_FILLER.has(words[j])) break;
      win.unshift(words[j]);
    }
    while (win.length && TITLE_FILLER.has(win[0])) win.shift();
    if (!win.length) continue;
    win[win.length - 1] = sing; // singularize the hint word ("nursing" -> "nurse")
    const t = win.join(" ").replace(/\b\w/g, (c) => c.toUpperCase());
    if (!out.includes(t)) out.push(t);
    if (out.length >= 2) break;
  }
  return out;
}
function intentWords(intent) {
  const out = new Set();
  if (intent.remote) ["remote", "wfh"].forEach((w) => out.add(w));
  if (intent.contract) ["contract", "freelance"].forEach((w) => out.add(w));
  if (intent.fullTime) ["fulltime", "full", "time"].forEach((w) => out.add(w));
  return out;
}

// "jobs in Austin" / "roles near Denver" -> ["austin"], ["denver"].
// Only additive in scoring (never a hard filter), so false positives are harmless.
function extractLocationFromMessage(text) {
  const m = String(text || "").toLowerCase().match(/\b(?:in|near|around)\s+([a-z][a-z .\-]{1,28}?)(?=\s+(?:jobs?|roles?|positions?|gigs?|work)\b|[?!.]|$)/);
  if (!m) return [];
  const loc = m[1].trim().replace(/[.\-]+$/, "");
  return loc.length >= 3 ? [loc] : [];
}
function termCase(t) {
  const conds = [];
  const params = [];
  for (const v of stems(t)) {
    conds.push("(lower(j.title) LIKE ? OR lower(j.description_text) LIKE ? OR lower(j.location) LIKE ?)");
    params.push(`%${v}%`, `%${v}%`, `%${v}%`);
  }
  return { sql: `(CASE WHEN ${conds.join(" OR ")} THEN 1 ELSE 0 END)`, params };
}

const JOB_COLS = `j.id, j.title, j.description_text, j.location, j.remote_policy, j.employment_type,
  j.salary_min, j.salary_max, j.salary_currency, j.posted_at, j.url,
  c.name AS company_name, c.industry AS company_industry, j.first_seen_at`;

// Candidates must match at least minHits distinct terms (precision first);
// callers relax to 1 when the strict pass is too thin.
async function searchJobs(db, terms, minHits, limit = 60) {
  const cases = [];
  const titleCases = [];
  let params = [];
  let titleParams = [];
  for (const t of terms.slice(0, 4)) {
    const { sql, params: p } = termCase(t);
    cases.push(sql);
    params = params.concat(p);
    const tc = [];
    for (const v of stems(t)) {
      tc.push(`(lower(j.title) LIKE ?)`);
      titleParams.push(`%${v}%`);
    }
    titleCases.push(`(CASE WHEN ${tc.join(" OR ")} THEN 1 ELSE 0 END)`);
  }
  if (!cases.length) return [];
  const hitExpr = cases.join(" + ");
  const titleExpr = titleCases.join(" + ");
  const rows = await db.prepare(`
    SELECT * FROM (
      SELECT ${JOB_COLS}, (${hitExpr}) AS term_hits, (${titleExpr}) AS title_hits
      FROM job j JOIN company c ON c.id = j.company_id
      WHERE j.is_active = 1 AND ((${cases.join(") OR (")}))
    ) WHERE term_hits >= ?
    ORDER BY title_hits DESC, term_hits DESC, first_seen_at DESC LIMIT ${limit}
  `).bind(...params, ...titleParams, ...params, minHits).all().catch(() => ({ results: [] }));
  return rows.results || [];
}

// No keywords at all (e.g. just "remote jobs"): newest jobs matching the
// work-style / employment-type filter.
async function searchJobsByFilter(db, where, limit = 40) {
  const rows = await db.prepare(`
    SELECT ${JOB_COLS} FROM job j JOIN company c ON c.id = j.company_id
    WHERE j.is_active = 1 AND ${where}
    ORDER BY j.first_seen_at DESC LIMIT ${limit}
  `).all().catch(() => ({ results: [] }));
  return rows.results || [];
}

function chatPrompt({ history, message, matchCount, searched }) {
  const hist = (history || []).slice(-6).map((h) => `${h.role === "assistant" ? "Assistant" : "User"}: ${h.content}`).join("\n");
  return [
    "You are the mehyar.jobs AI assistant — friendly, concise, a little playful. You help people find jobs from our live database of thousands of postings across every industry.",
    "",
    "STRICT RULES (violating any of these fails your answer):",
    "- Write 1-2 short sentences ONLY: acknowledge what they asked for, point them at the matches below.",
    "- NEVER name, describe, count, or characterize any specific job, company, salary, or score. No job titles. No company names. No percentages. No bullet lists.",
    "- Refer to results only as 'the matches below'.",
    "- If no matches were found, say so in one sentence and suggest ONE concrete tweak (a keyword, a nearby city, or remote).",
    "- If the user hasn't shared a resume, you may add one short line: 'Attach your resume with the paperclip button and I'll score everything against your background.'",
    "- Plain text only. No markdown, no bold, no code fences.",
    hist ? `\nConversation so far:\n${hist}` : "",
    searched ? `\nMatches found: ${matchCount} (rendered as cards below your reply — you cannot see their details)` : "",
    `\nUser: ${message}`,
    "\nAssistant (1-2 sentences, no job names, no companies, no scores):",
  ].join("\n");
}

// The model can only be trusted with 1-2 framing sentences: truncate anything
// beyond that (it tends to append invented card enumerations), then run the
// hallucination guard on what remains.
function firstSentences(text, n = 2) {
  const parts = String(text || "")
    .split(/\n+/)
    .flatMap((block) => block.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.slice(0, n).join(" ").trim();
}

// The model must never name companies/jobs/scores — those render as cards.
// If the reply violates that (invented names, percentages, bullet job lists,
// card enumerations), fall back to a deterministic answer. A mentioned company
// is only allowed when it appears in the match list.
function replyHallucinates(reply, matches) {
  const t = String(reply || "");
  if (/\d+\s?%\s*(match|fit)/i.test(t)) return true;
  if (/\(\d{2,3}\s?\/\s?100/.test(t)) return true;
  if (/card\s*\d+\s*:/i.test(t)) return true;
  if (/^\s*[•\-*]\s+[A-Z]/m.test(t)) return true;
  const companies = new Set((matches || []).map((m) => String(m.company_name || "").toLowerCase()));
  // Company mentions: "at" followed by 1-4 capitalized words.
  const mentioned = t.match(/\bat\s+([A-Z][A-Za-z0-9&']+(?:\s+[A-Z][A-Za-z0-9&']+){0,3})/g) || [];
  for (const mm of mentioned) {
    const name = mm.replace(/^at\s+/i, "").trim().toLowerCase();
    let known = false;
    for (const c of companies) {
      if (c && (c.includes(name) || name.includes(c))) { known = true; break; }
    }
    if (!known) return true;
  }
  return false;
}

// Exported for tests.
export { replyHallucinates, deterministicReply, extractTitlesFromMessage, extractLocationFromMessage, firstSentences };
function deterministicReply({ message, matches, searched }) {
  if (!searched) {
    return "Hey! Ask me things like 'remote Python jobs', 'nursing roles in Austin', or 'highest-paying analyst jobs' — I'll search our live database and score the matches. Attach your resume with the paperclip button for fit scores tuned to you.";
  }
  if (matches.length) {
    return `I found ${matches.length} relevant ${matches.length === 1 ? "match" : "matches"} — the top ones are listed below with fit scores and apply links. Attach your resume with the paperclip button and I'll score everything against your background.`;
  }
  return "Nothing strong in the live database for that yet. Try different keywords, a nearby city, or remote — or attach your resume with the paperclip button so I can match on your skills.";
}

export async function handleChat(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return corsJson({ ok: false, error: "method_not_allowed" }, 405);
  if (!env.AI || typeof env.AI.run !== "function") return corsJson({ ok: false, error: "ai_unavailable" }, 503);
  if (!env.JOBS_DB) return corsJson({ ok: false, error: "no_db" }, 500);

  const identity = await resolveChatIdentity(request, env);
  if (!identity.ok) return corsJson({ ok: false, error: identity.error, message: identity.message }, identity.status);

  let body = {};
  try { body = await request.json(); } catch { /* fall through */ }
  const message = String(body.message || "").slice(0, MAX_MESSAGE_CHARS).trim();
  if (message.length < 2) return corsJson({ ok: false, error: "message_too_short" }, 400);
  const history = Array.isArray(body.history) ? body.history
    .filter((h) => h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string")
    .slice(-6)
    .map((h) => ({ role: h.role, content: h.content.slice(0, 1000) })) : [];

  const db = env.JOBS_DB;
  const intent = detectIntent(message);
  const terms = extractTerms(message);

  // ATS Mirror short-circuit: the user wants a resume audit, not job matches.
  // Deterministic reply with a CTA button (no AI call, no DB search).
  if (intent.wantsAts && !intent.wantsJob) {
    await recordAnonUse(db, identity.gateKey, "chat").catch(() => null);
    return corsJson({
      ok: true,
      reply: "Love that instinct — most resumes die in the ATS before a human ever sees them. My ATS Mirror scores yours across the 9 dimensions the robots actually check, shows every fix, and hands you a rewritten ATS-safe version to download. It's free.",
      matches: [],
      searched: false,
      cta: { label: "🪞 Open the ATS Mirror", href: "/ats-mirror" },
      chat_remaining: Math.max(0, identity.remaining - 1),
      bonus_used: !!identity.bonus_used,
    });
  }

  // Profile: member's saved resume > pasted resume > keywords from the message.
  // richProfile = scored against a real resume (strict floor); otherwise the
  // message itself is the profile (lenient floor).
  let profile = null;
  let profileDesc = "";
  let richProfile = false;
  try {
    if (identity.user) {
      const mp = await getUserFitProfile(env, identity.user.id).catch(() => null);
      if (mp && (mp.keywords?.length || mp.target_titles?.length)) {
        profile = mp;
        richProfile = true;
        profileDesc = `target titles: ${(mp.target_titles || []).slice(0, 3).join(", ") || "any"}; skills: ${(mp.keywords || []).slice(0, 12).join(", ")}`;
      }
    }
    const resumeText = String(body.resume_text || "").slice(0, 12000);
    if (!profile && resumeText.trim().length >= 200) {
      profile = deriveProfileFromResume(resumeText, {});
      richProfile = true;
      profileDesc = `target titles: ${(profile.target_titles || []).slice(0, 3).join(", ") || "any"}; skills: ${(profile.keywords || []).slice(0, 12).join(", ")}`;
    }
  } catch { /* fall through to term-based profile */ }
  if (!profile) {
    // Shortest stem per term so fit.js substring matching works
    // ("nursing" -> "nurs" hits "nurse").
    const stemmed = [...new Set(terms.map((t) => stems(t).pop()))];
    profile = {
      target_titles: [], keywords: stemmed, locations: extractLocationFromMessage(message),
      exclude_keywords: [], preferred_industries: [], excluded_industries: [],
    };
  }
  // Even without a resume, pull a target title from the message itself so
  // title matching works ("remote software engineer jobs" -> Software Engineer).
  if (!profile.target_titles?.length) {
    const msgTitles = extractTitlesFromMessage(message);
    if (msgTitles.length) {
      profile = { ...profile, target_titles: msgTitles };
      if (profileDesc) profileDesc += `; inferred target: ${msgTitles.join(", ")}`;
      else profileDesc = `inferred target titles: ${msgTitles.join(", ")}; keywords: ${terms.slice(0, 8).join(", ")}`;
    }
  }
  const hasSignal = (profile.target_titles?.length || profile.keywords?.length) ? true : false;

  // Search the DB when the message looks like a job request — or when a resume
  // is attached/saved and the user asks what fits (terms may be empty).
  let matches = [];
  let searched = false;
  if (!intent.greeting && (intent.wantsJob || terms.length > 0 || richProfile)) {
    searched = true;
    const drop = intentWords(intent);
    const keywords = terms.filter((t) => !drop.has(t));
    // Location words ("austin") are a soft preference, not a hard search term:
    // search on the "what" terms, let fit.js location scoring rank the "where".
    const locWords = new Set(
      extractLocationFromMessage(message).flatMap((l) => l.split(/[^a-z0-9]+/)).filter((w) => w.length >= 3)
    );
    const whatTerms = keywords.filter((t) => ![...locWords].some((w) => t.includes(w) || w.includes(t)));
    const searchTerms = whatTerms.length ? whatTerms : keywords;
    let candidates = [];
    if (searchTerms.length) {
      // Strict pass first (multi-term precision), relax to any-term on thin results.
      candidates = await searchJobs(db, searchTerms, Math.min(2, searchTerms.length));
      if (candidates.length < 3 && searchTerms.length > 1) {
        candidates = await searchJobs(db, searchTerms, 1);
      }
      if (richProfile && profile.keywords?.length) {
        // Resume-driven discovery: union resume-keyword matches so
        // "what fits me best?" (message terms are noise like "fits")
        // still surfaces real matches. Scoring + floor filter later.
        const pk = profile.keywords.slice(0, 10);
        const extra = await searchJobs(db, pk, Math.min(2, pk.length));
        const ids = new Set(candidates.map((c) => c.id));
        for (const c of extra) {
          if (!ids.has(c.id)) { ids.add(c.id); candidates.push(c); }
        }
      }
    } else if (richProfile && profile.keywords?.length) {
      // No usable message terms at all: search on the resume itself.
      const pk = profile.keywords.slice(0, 10);
      candidates = await searchJobs(db, pk, Math.min(2, pk.length));
    } else if (intent.remote || intent.contract) {
      candidates = await searchJobsByFilter(
        db,
        intent.remote ? "j.remote_policy = 'remote'" : "j.employment_type = 'contract'"
      );
    } else {
      candidates = await searchJobs(db, terms.length ? terms : profile.keywords || [], 1);
    }
    const scored = [];
    for (const c of candidates) {
      const job = {
        title: c.title, description_text: c.description_text, location: c.location,
        remote_policy: c.remote_policy, employment_type: c.employment_type,
        salary_min: c.salary_min, salary_max: c.salary_max, posted_at: c.posted_at,
      };
      const out = scoreJob(job, profile, c.company_industry);
      if (out.hard_no) continue;
      // Explicit query terms hitting the job title deserve a real boost:
      // "python jobs" should rank "Senior Python Engineer" above a job that
      // merely mentions python once in its description. Word-boundary match
      // so noise terms ("fits") can't boost "Benefits Analyst".
      const titleLower = String(c.title || "").toLowerCase();
      let titleHit = false;
      for (const t of searchTerms) {
        for (const v of stems(t)) {
          const esc = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          if (v.length >= 4 && new RegExp(`\\b${esc}\\b`).test(titleLower)) { titleHit = true; break; }
        }
        if (titleHit) break;
      }
      const score = out.score + (titleHit ? 25 : 0);
      const rank = score + (intent.remote && c.remote_policy === "remote" ? 10 : 0)
        + (intent.contract && c.employment_type === "contract" ? 10 : 0);
      scored.push({ c, score, rank });
    }
    scored.sort((a, b) => b.rank - a.rank);
    // Only show genuinely relevant matches as cards. Rich (resume-backed)
    // profiles get a strict floor; thin message-only profiles a lenient one —
    // candidate pre-filtering (multi-term hits) already did the precision work.
    // In pure-filter browse mode (no keywords/titles at all) show the newest
    // instead — the AI explains that scores need a resume.
    // Dedupe identical title+company rows (repeat scrapes) before slicing.
    const floor = richProfile ? 30 : hasSignal ? 15 : 0;
    const seen = new Set();
    const deduped = [];
    for (const s of scored) {
      if (s.score < floor) continue;
      const key = `${String(s.c.title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}|${String(s.c.company_name || "").toLowerCase().trim()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(s);
      if (deduped.length >= 6) break;
    }
    matches = deduped.map((s) => ({
      id: s.c.id, title: s.c.title, url: s.c.url,
      company_name: s.c.company_name, company_industry: s.c.company_industry,
      location: s.c.location, remote_policy: s.c.remote_policy,
      employment_type: s.c.employment_type,
      salary_min: s.c.salary_min, salary_max: s.c.salary_max,
      salary_currency: s.c.salary_currency, posted_at: s.c.posted_at,
      score: s.score,
    }));
  }

  let reply;
  try {
    const ai = await env.AI.run(MODEL, {
      prompt: chatPrompt({ history, message, matchCount: matches.length, searched }),
      max_tokens: 400,
    });
    reply = String(ai?.response || "").replace(/```/g, "").replace(/\*\*/g, "").trim();
    reply = firstSentences(reply, 2);
  } catch (e) {
    console.error(JSON.stringify({ event: "chat_ai_error", error: String(e?.message || e).slice(0, 200) }));
  }
  if (!reply || reply.length < 10 || replyHallucinates(reply, matches)) {
    if (reply && replyHallucinates(reply, matches)) {
      console.error(JSON.stringify({ event: "chat_hallucination_blocked", reply: reply.slice(0, 200) }));
    }
    reply = deterministicReply({ message, matches, searched });
  }

  await recordAnonUse(db, identity.gateKey, "chat");
  return corsJson({
    ok: true,
    reply: reply.slice(0, 3000),
    matches,
    searched,
    chat_remaining: Math.max(0, identity.remaining - 1),
    bonus_used: !!identity.bonus_used,
  });
}
