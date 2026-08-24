import assert from "node:assert/strict";
import { inferEmploymentType, normLoc } from "../functions/_lib/scrapers/index.js";
import { extractSalary } from "../functions/_shared/salary.js";

assert.equal(normLoc("Remote-Friendly, United States").remote_policy, "remote");
assert.equal(normLoc("Work from anywhere").remote_policy, "remote");
assert.equal(normLoc("New York (Hybrid)").remote_policy, "hybrid");

assert.equal(inferEmploymentType("Contractor", "Backend Engineer"), "contract");
assert.equal(inferEmploymentType("Full Time", "Software Engineer"), "full_time");
assert.equal(inferEmploymentType(null, "Senior React Engineer (1099)"), "contract");
assert.equal(inferEmploymentType(null, "Systems Engineer", "Employment type: Contractor"), "contract");
assert.equal(inferEmploymentType(null, "Contract Document Specialist"), "contract");

assert.equal(extractSalary("Benefits include 401(k) matching"), null);
assert.equal(extractSalary("We serve 40M users worldwide"), null);
assert.deepEqual(extractSalary("Contract rate: $85/hour"), {
  min: 176800,
  max: 176800,
  currency: "USD",
  raw: "$85/hour",
  kind: "hourly",
});

console.log("scanner normalization tests passed");
