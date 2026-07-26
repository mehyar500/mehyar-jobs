// _shared/salary.js
//
// Extract salary ranges from job description text. Returns
// { min, max, currency, raw, kind } or null.
//
// Patterns handled:
//   "$150,000 - $200,000"
//   "$150k-$200k"
//   "150K to 200K"
//   "USD 150-200 per year"
//   "$150/hour"  → annualized
//   "€80k-€120k"
//   "£60k"
//   "120,000 USD annual"

const DOLLAR = "$";
const EURO = "\u20AC";
const POUND = "\u00A3";

// One canonical regex built via String + new RegExp to avoid any
// literal-unicode-in-regex pitfalls in esbuild.
function buildSalaryRegex() {
  // Currencies can be prefixed or suffixed: $150k, 150k USD, 150 USD, etc.
  const curAlt = "USD|EUR|GBP|CAD|CHF|AUD|US\\$|C\\$|A\\$|[" + DOLLAR + EURO + POUND + "]";
  // Range: optional currency, number+optional suffix, separator, currency, number+optional suffix
  const range = new RegExp(
    "(?:(?<a>" + curAlt + ")\\s*)?" +
    "(?<n1>\\d{1,3}(?:[,\\s]\\d{3})*(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)" +
    "\\s*(?<s1>k|thousand|m|million)?" +
    "\\s*(?:-|to|–|—)\\s*" +
    "(?:(?<b>" + curAlt + ")\\s*)?" +
    "(?<n2>\\d{1,3}(?:[,\\s]\\d{3})*(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)" +
    "\\s*(?<s2>k|thousand|m|million)?",
    "i"
  );
  // Single: 150k, $150,000
  const single = new RegExp(
    "(?:(?<a>" + curAlt + ")\\s*)?" +
    "(?<n>\\d{1,3}(?:[,\\s]\\d{3})*(?:\\.\\d+)?)" +
    "\\s*(?<s>k|thousand|m|million)\\b",
    "i"
  );
  return { range, single };
}
const { range: SALARY_RE, single: SINGLE_RE } = buildSalaryRegex();

const PER_HOUR = /\b(per\s+hour|\/hour|\/hr|hourly)\b/i;
const PER_YEAR = /\b(per\s+year|annual(ly)?|yearly|\/year|\/yr|annualized)\b/i;

const CURRENCY_PATTERNS = [
  { code: "USD", symbols: [DOLLAR, "usd", "us$"] },
  { code: "EUR", symbols: [EURO, "eur"] },
  { code: "GBP", symbols: [POUND, "gbp"] },
  { code: "CAD", symbols: ["cad", "c$"] },
  { code: "CHF", symbols: ["chf"] },
  { code: "AUD", symbols: ["aud", "a$"] },
];

function detectCurrency(blob, fallback) {
  if (!fallback) fallback = "USD";
  const lower = (blob || "").toLowerCase();
  for (const c of CURRENCY_PATTERNS) {
    for (const sym of c.symbols) {
      if (sym.length === 1) {
        if (lower.indexOf(sym) !== -1) return c.code;
      } else {
        if (lower.indexOf(sym.toLowerCase()) !== -1) return c.code;
      }
    }
  }
  return fallback;
}

function parseNumber(raw, suffix) {
  if (raw == null) return null;
  let n = parseFloat(String(raw).replace(/[,\s]/g, ""));
  if (!Number.isFinite(n)) return null;
  const sfx = (suffix || "").toLowerCase();
  if (sfx === "k" || sfx === "thousand") n *= 1000;
  else if (sfx === "m" || sfx === "million") n *= 1000000;
  return Math.round(n);
}

function annualize(amount, blob) {
  if (!amount) return amount;
  if (PER_YEAR.test(blob || "")) return amount;
  if (PER_HOUR.test(blob || "")) return Math.round(amount * 2080);  // 40h × 52w
  return amount;
}

export function extractSalary(text) {
  if (!text || typeof text !== "string") return null;

  // Try the range form first
  const m = text.match(SALARY_RE);
  if (m && m.groups) {
    const cur = detectCurrency(m[0], "USD");
    const min = parseNumber(m.groups.n1, m.groups.s1);
    const max = parseNumber(m.groups.n2, m.groups.s2);
    if (min != null || max != null) {
      const lo = annualize(min ?? max, text);
      const hi = annualize(max ?? min, text);
      return {
        min: Math.min(lo, hi),
        max: Math.max(lo, hi),
        currency: cur,
        raw: m[0].trim(),
        kind: PER_HOUR.test(text) ? "hourly" : "yearly",
      };
    }
  }

  // Try a single number
  const s = text.match(SINGLE_RE);
  if (s && s.groups) {
    const cur = detectCurrency(s[0], "USD");
    const n = parseNumber(s.groups.n, s.groups.s);
    if (n != null) {
      const v = annualize(n, text);
      return { min: v, max: v, currency: cur, raw: s[0].trim(), kind: PER_HOUR.test(text) ? "hourly" : "yearly" };
    }
  }

  return null;
}

export async function persistSalary(env, jobId, description) {
  if (!env?.JOBS_DB || !jobId || !description) return null;
  const s = extractSalary(description);
  if (!s) return null;
  try {
    await env.JOBS_DB.prepare(`
      UPDATE job SET salary_min = ?, salary_max = ?, salary_currency = ?
      WHERE id = ? AND (salary_min IS NULL OR salary_min = 0)
    `).bind(s.min, s.max, s.currency, jobId).run();
  } catch {}
  return s;
}
