import assert from "node:assert/strict";
import { loadProfile, scoreJob } from "../functions/_shared/fit.js";

const profile = await loadProfile({
  full_name: "Mehyar Swelim",
  email: "mrswelim@gmail.com",
  target_titles_json: JSON.stringify(["AI Engineer"]),
  keywords_json: JSON.stringify(["llm", "typescript"]),
  exclude_keywords_json: JSON.stringify(["clearance required"]),
  locations_json: JSON.stringify(["Remote"]),
  remote_required: 1,
  min_salary_usd: 160000,
  preferred_industries_json: JSON.stringify(["Software"]),
  excluded_industries_json: JSON.stringify([]),
});

assert.deepEqual(profile.target_titles, ["AI Engineer"]);
assert.equal(profile.full_name, "Mehyar Swelim");
assert.equal(profile.email, "mrswelim@gmail.com");

const strongMatch = scoreJob({
  title: "Applied AI Engineer",
  description_text: "Build LLM systems and TypeScript services.",
  location: "United States",
  remote_policy: "remote",
  salary_min: 180000,
  posted_at: new Date().toISOString(),
}, profile, "Software");
assert.equal(strongMatch.hard_no, 0);
assert.ok(strongMatch.score >= 80, `expected a high score, got ${strongMatch.score}`);

const rejectedMatch = scoreJob({
  title: "AI Engineer - Clearance Required",
  description_text: "LLM and TypeScript work.",
  location: "Remote",
  remote_policy: "remote",
  salary_min: 190000,
}, profile, "Software");
assert.equal(rejectedMatch.hard_no, 1);
assert.match(rejectedMatch.hard_no_reason, /excluded keyword/i);

console.log("pipeline logic tests passed");
