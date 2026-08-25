import assert from "node:assert/strict";
import { buildJobWhere, readJobFilters } from "../functions/api/admin/jobs.js";

const parsed = readJobFilters(new URL("https://jobs.test/api/admin/jobs?engagement=contract&posted_within=7&fit_min=70&salary_min=120000&remote=remote"));
assert.equal(parsed.engagement, "contract");
assert.equal(parsed.postedWithin, 7);
assert.equal(parsed.fitMin, 70);
assert.equal(parsed.salaryMin, 120000);

const contract = buildJobWhere(parsed);
const contractSql = contract.where.join(" ");
assert.match(contractSql, /employment_type/);
assert.match(contractSql, /COALESCE\(j\.posted_at, j\.first_seen_at\)/);
assert.match(contractSql, /jf\.score >= \?/);
assert.doesNotMatch(contractSql, /jf\.score IS NULL/);
assert.match(contractSql, /COALESCE\(j\.salary_min, j\.salary_max, 0\) >= \?/);
assert.deepEqual(contract.binds, ["remote", "-7 day", 120000, 70]);

const employee = buildJobWhere(readJobFilters(new URL("https://jobs.test/api/admin/jobs?engagement=employee&q=Engineer&industry=AI")));
assert.match(employee.where.join(" "), /'full_time'/);
assert.deepEqual(employee.binds, ["%engineer%", "%engineer%", "%engineer%", "AI"]);

const clamped = readJobFilters(new URL("https://jobs.test/api/admin/jobs?fit_min=999&posted_within=-2&salary_min=nope&limit=500"));
assert.equal(clamped.fitMin, 100);
assert.equal(clamped.postedWithin, 0);
assert.equal(clamped.salaryMin, 0);
assert.equal(clamped.limit, 100);

console.log("job filter tests passed");
