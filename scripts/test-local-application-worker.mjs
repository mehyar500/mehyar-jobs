import assert from "node:assert/strict";
import { validateLocalRun } from "../functions/api/admin/applications/[id]/local-run.js";

const base = { outcome: "review_ready", fields: [{ label: "Email", value: "me@example.com", source: "profile" }], answers: [], cover_letter: "Specific and factual." };
assert.equal(validateLocalRun(base), null);
assert.equal(validateLocalRun({ ...base, outcome: "unknown" }), "invalid_outcome");
assert.equal(validateLocalRun({ ...base, fields: Array.from({ length: 101 }, () => ({ label: "x" })) }), "invalid_field_count");
assert.equal(validateLocalRun({ ...base, screenshot_base64: "x".repeat(2_000_001) }), "invalid_screenshot");
console.log("local application worker payload checks passed");
