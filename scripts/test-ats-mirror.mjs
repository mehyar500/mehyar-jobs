// scripts/test-ats-mirror.mjs — ATS Mirror prompt honesty + audit shape tests.
// Run: node scripts/test-ats-mirror.mjs
import { auditPrompt, rewritePrompt } from "../scanner-worker/src/atsMirror.js";

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error("FAIL:", name); }
}

// 1. Rewrite prompt must carry the anti-fabrication rules (regression test:
//    the LLM once invented "90% efficiency gains" and Java/Python expertise
//    for a resume that had neither).
const rp = rewritePrompt("Did various tasks as assigned.", "Senior Software Engineer", ["Java", "Python"]);
const rpl = rp.toLowerCase();
ok(rpl.includes("honesty is the hard rule"), "rewrite: honesty hard rule");
ok(rpl.includes("never invent"), "rewrite: never invent");
ok(rpl.includes("placeholder"), "rewrite: metric placeholder convention");
ok(rpl.includes("keywords to earn"), "rewrite: unearnt keywords listed, not claimed");
ok(rpl.includes("only if the original resume evidences it"), "rewrite: truthful keyword weaving");

// 2. Rewrite prompt must include the target role and original resume.
ok(rp.includes("Senior Software Engineer"), "rewrite: target role present");
ok(rp.includes("Did various tasks as assigned."), "rewrite: original resume present");

// 3. Audit prompt must demand strict JSON with the expected keys.
const ap = auditPrompt("JOHN DOE\nEngineer", "Engineer");
for (const k of ['"score"', '"verdict"', '"issues"', '"missing_keywords"', '"stats"']) {
  ok(ap.includes(k), `audit: key ${k} required`);
}
ok(ap.includes("Score like a machine, not a cheerleader"), "audit: no-cheerleader scoring rule");

console.log(`ats-mirror: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
