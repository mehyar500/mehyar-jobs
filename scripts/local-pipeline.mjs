// Local operator for the shared Cloudflare-backed job pipeline.
//
// The process runs on this computer; Cloudflare remains the source of truth
// for the D1 data and remote review UI. Browser submission is handled by
// scripts/local-daily-auto-apply.mjs.
// Usage: npm run local:pipeline -- status|score|queue [fit-min] [max]

const command = process.argv[2] || "status";
const baseUrl = (process.env.JOBS_BASE_URL || "https://jobs.mehyar.us").replace(/\/$/, "");
let token = process.env.MEHYAR_JOBS_TOKEN || "";

if (!token && process.env.MEHYARSOFT_ADMIN_USERNAME && process.env.MEHYARSOFT_ADMIN_PASSWORD) {
  const response = await fetch(baseUrl + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: process.env.MEHYARSOFT_ADMIN_USERNAME,
      password: process.env.MEHYARSOFT_ADMIN_PASSWORD,
    }),
  });
  const body = await response.json().catch(() => ({}));
  token = body.token || "";
}

if (!token) {
  console.error("Set MEHYAR_JOBS_TOKEN or MEHYARSOFT_ADMIN_USERNAME and MEHYARSOFT_ADMIN_PASSWORD in this local shell.");
  process.exit(1);
}

async function request(path, init = {}) {
  const response = await fetch(baseUrl + path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${body.error || response.statusText}`);
  return body;
}

if (command === "status") {
  const data = await request("/api/admin/pipeline");
  console.log(JSON.stringify(data, null, 2));
} else if (command === "score") {
  console.log(JSON.stringify(await request("/api/admin/cron/score", { method: "POST" }), null, 2));
} else if (command === "queue") {
  const fitMin = Number(process.argv[3] || 70);
  const max = Number(process.argv[4] || 10);
  console.log(JSON.stringify(await request("/api/admin/applications/queue", {
    method: "POST",
    body: JSON.stringify({ fit_min: fitMin, max, run_now: false }),
  }), null, 2));
} else {
  console.error("Usage: npm run local:pipeline -- status|score|queue [fit-min] [max]\nSubmit daily target: npm run local:daily-auto-apply -- --fit-min 70 --target 10");
  process.exit(1);
}
