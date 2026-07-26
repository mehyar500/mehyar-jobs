// _shared/coverLetter.js
//
// Deterministic cover-letter + custom-answer draft generator.
// Pure functions, easy to test. No external LLM needed for the first
// pass — the template uses the user's profile + the job's data to
// produce a specific, accurate letter that beats the generic "I am
// writing to apply" stuff.
//
// The template intentionally avoids the AI tells that recruiters spot:
//   - no "I am writing to express my interest"
//   - no "I am confident my skills make me a great fit"
//   - no "Thank you for your consideration"
//
// Instead, it leads with the matching title+keywords (the reasons
// that scored this job high), references concrete company facts pulled
// from the job description, and ties the user's profile to the role.

function lc(s) { return String(s || "").toLowerCase(); }

function pickTitle(profile, job) {
  const titles = profile?.target_titles || [];
  const jt = lc(job?.title || "");
  for (const t of titles) if (jt.includes(lc(t))) return t;
  return titles[0] || "this role";
}

function findOverlapKeywords(profile, job) {
  const keys = profile?.keywords || [];
  const hay = `${job?.title || ""} ${job?.description_text || ""}`.toLowerCase();
  return keys.filter((k) => hay.includes(lc(k)));
}

function findOverlapIndustries(profile, job) {
  const pref = profile?.preferred_industries || [];
  return pref.filter((p) => lc(job?.industry || "").includes(lc(p)));
}

export function generateCoverLetter({ profile, job, company }) {
  const title = pickTitle(profile, job);
  const overlap = findOverlapKeywords(profile, job);
  const industries = findOverlapIndustries(profile, job);
  const compName = company?.name || job?.company_name || "your company";
  const location = job?.location || company?.hq_state || company?.hq_country || "";
  const remote = job?.remote_policy;

  const lines = [];
  lines.push(`Hi ${compName} team,`);
  lines.push("");
  lines.push(`I'm applying for the ${job?.title || "open role"} on the ${title} track. The match jumped out: the role is ${location ? "based in " + location : "open"}${remote && remote !== "unknown" ? " (" + remote + ")" : ""}, and it asks for ${overlap.length ? overlap.slice(0, 5).join(", ") : "the same stack I work in daily"}.`);
  lines.push("");

  if (industries.length) {
    lines.push(`A bit of context: I've spent the past several years in ${industries.slice(0, 2).join(" and ")} — the problems you all are solving are the ones I've been gravitating toward.`);
  } else {
    lines.push(`A bit of context: the problems you're solving line up with what I've been working on.`);
  }
  lines.push("");

  if (profile?.notes) {
    lines.push(`Quick note on what I'm looking for: ${profile.notes.trim()}`);
    lines.push("");
  }

  if (profile?.min_salary_usd) {
    const s = profile.min_salary_usd;
    lines.push(`Comp target: ~$${s.toLocaleString()} base (open on the structure, including equity, signing, and any cash upside).`);
    lines.push("");
  }

  lines.push(`Happy to walk through any of the above on a quick call. My email is in my resume.`);
  lines.push("");
  lines.push(`—`);
  lines.push("");

  return lines.join("\n").trim();
}

// Custom answers for the standard "Why this company / role" / "Tell us
// about yourself" / "What are you looking for" questions that every ATS
// has. The map is keyed by canonical question; the form map of
// `{ "<their question>": "<canonical>" }` is computed at draft time.
export function generateCustomAnswers({ profile, job, company }) {
  const title = pickTitle(profile, job);
  const overlap = findOverlapKeywords(profile, job);
  const compName = company?.name || job?.company_name || "your company";
  const ind = profile?.preferred_industries?.[0] || "this space";

  return {
    "why_company":   `I'm applying to ${compName} specifically because the work is in ${ind} and the role description reads like the intersection of what I've been doing (${overlap.slice(0,3).join(", ") || "the same stack"}) and what I want to go deeper on. ${compName}'s pace + the specific scope of this role is a better match than the more general postings I've seen elsewhere.`,
    "why_role":      `The role is a direct line extension of what I've been working on. The title (${title}) matches how I've been positioning myself, and the keywords you all call out — ${overlap.slice(0,5).join(", ") || "the tech listed"} — are the ones I want to be using more of, not less.`,
    "tell_us_about_yourself": (() => {
      const years = profile?.years_experience || "several";
      const inds = (profile?.preferred_industries || []).slice(0, 2).join(" and ") || "a few different sectors";
      return `I've spent the last ${years} years working in ${inds}. Most of my work has been on the kind of systems that turn user intent into reliable output — the boring-but-load-bearing infrastructure that makes a product feel fast and predictable. I care about a few things: shipping things that work without hand-holding, writing code that another engineer can read a year from now, and being the person who actually closes the loop when something breaks.`;
    })(),
    "what_are_you_looking_for": profile?.notes || `A role where I can go deep on the work that matters and not get pulled into status meetings about it. ${profile?.remote_required ? "Fully remote is required; I do my best work from a quiet room, not a co-working space. " : ""}${profile?.min_salary_usd ? `Comp target: ~$${profile.min_salary_usd.toLocaleString()} base, structure flexible. ` : ""}Willing to relocate for the right role but not actively looking to.`,
    "greatest_achievement": `I can't point to one specific achievement without the rest of the team — the work I care about has always been the work where the deliverable was "the system now does X reliably" and the answer to "who built this" was a few people, not one. I'd rather show you the system than describe it.`,
    "why_leaving": `Looking for a place where the work has more weight and the team has more room to make calls without going up the chain for every decision.`,
    "salary_expectations": profile?.min_salary_usd
      ? `Target is ~$${profile.min_salary_usd.toLocaleString()} base; structure flexible on equity/signaling/cash.`
      : `Open to discussing once I've seen the full scope.`,
    "work_authorization": `Authorized to work in the US; no visa sponsorship needed at this time.`,
    "willing_to_relocate": profile?.remote_required
      ? `Looking for a fully remote role; not currently open to relocation.`
      : `Open to relocation for the right role, but remote-first strongly preferred.`,
  };
}

// Match a job's actual custom questions (extracted from description)
// to our canonical answers above. Returns an array of {q, a} pairs.
export function matchCustomQuestions(questions, answers) {
  const out = [];
  for (const q of questions) {
    const ql = lc(q);
    let best = null;
    for (const [canon, ans] of Object.entries(answers)) {
      const canonWords = canon.replace(/_/g, " ");
      if (ql.includes(canonWords) || ql.includes(canonWords.split(" ")[0])) { best = ans; break; }
    }
    // Heuristics for unlabeled questions
    if (!best) {
      if (ql.includes("salary") || ql.includes("comp") || ql.includes("compensation")) best = answers.salary_expectations;
      else if (ql.includes("relocat")) best = answers.willing_to_relocate;
      else if (ql.includes("authoriz") || ql.includes("visa") || ql.includes("sponsor")) best = answers.work_authorization;
      else if (ql.includes("why") && (ql.includes("us") || ql.includes("company") || ql.includes("role"))) best = ql.includes("role") ? answers.why_role : answers.why_company;
      else if (ql.includes("about yourself") || ql.includes("tell us")) best = answers.tell_us_about_yourself;
      else if (ql.includes("leaving") || ql.includes("current") && ql.includes("role")) best = answers.why_leaving;
      else if (ql.includes("achievement") || ql.includes("proud")) best = answers.greatest_achievement;
      else best = "(write a 1-2 sentence answer specific to this prompt)";
    }
    out.push({ q, a: best });
  }
  return out;
}

// Pull likely custom-question prompts out of a job description.
const QUESTION_HINTS = [
  /\bwhy[^.]{0,40}(?:us|company|role|position|here|interested|good fit)[^.]{0,80}\?/gi,
  /\btell us about yourself[^.]{0,80}\?/gi,
  /\bwhat[^.]{0,40}(?:looking for|motivat|interest you|excite)[^.]{0,80}\?/gi,
  /\bsalary[^.]{0,40}(?:expect|require|range|target)[^.]{0,80}\?/gi,
  /\b(willing|able)\s+to\s+(?:relocate|work[^.]{0,20}(?:remote|hybrid|on-?site))[^.]{0,80}\?/gi,
  /\b(work|visa)\s+(?:authoriz|sponsor|permission)[^.]{0,80}\?/gi,
  /\b(greatest|biggest|proudest|most[^.]{0,20}significant)\s+(?:achievement|accomplishment|project)[^.]{0,80}\?/gi,
  /\bwhy[^.]{0,40}(?:leaving|current|previous)[^.]{0,80}\?/gi,
];
export function extractQuestions(description) {
  if (!description) return [];
  const out = new Set();
  for (const re of QUESTION_HINTS) {
    for (const m of description.matchAll(re)) out.add(m[0].trim());
  }
  return Array.from(out).slice(0, 12);
}
