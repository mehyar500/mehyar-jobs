import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const port = 4175;
const origin = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port)], {
  stdio: ["ignore", "pipe", "pipe"],
});

let browser;
try {
  await waitForServer(origin);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(() => {
    localStorage.setItem("mehyar_jobs_token_v1", "browser-test-token");
    localStorage.setItem("mehyar_jobs_principal_v1", JSON.stringify({ sub: "test" }));
  });

  let latestJobsRequest = "";
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/admin/jobs") {
      latestJobsRequest = url.toString();
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          total: 1,
          facets: [{ industry: "Technology", n: 1 }],
          items: [{
            id: 1,
            title: "Senior Product Engineer",
            url: "https://example.test/jobs/1",
            company_name: "Example Co",
            industry: "Technology",
            location: "Remote — US",
            remote_policy: "remote",
            employment_type: "full_time",
            score: 88,
            posted_at: new Date().toISOString(),
            reasons: ["title match"],
          }],
        }),
      });
    }
    if (url.pathname === "/api/public/stats") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ companies: 1, jobs: 1, scrape_runs: 1 }) });
    }
    if (url.pathname === "/api/admin/applications") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [] }) });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.goto(`${origin}/jobs`);
  await page.getByTestId("job-filters").waitFor();

  await page.getByRole("button", { name: "Full-time", exact: true }).click();
  await waitForQuery(() => latestJobsRequest, "engagement", "employee");

  await page.getByTestId("recent-filter").selectOption("7");
  await waitForQuery(() => latestJobsRequest, "posted_within", "7");

  await page.getByRole("button", { name: "70+", exact: true }).click();
  await waitForQuery(() => latestJobsRequest, "fit_min", "70");

  await page.getByLabel("Minimum salary").selectOption("120000");
  await waitForQuery(() => latestJobsRequest, "salary_min", "120000");

  await page.getByTestId("job-search").fill("product engineer");
  await waitForQuery(() => latestJobsRequest, "q", "product engineer");
  await page.getByRole("button", { name: /Clear 5 filters/ }).waitFor();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `mobile layout overflows horizontally by ${overflow}px`);

  const screenshot = join(tmpdir(), "mehyar-jobs-filters-mobile.png");
  await page.screenshot({ path: screenshot, fullPage: true });

  await page.getByTestId("clear-job-filters").click();
  await page.getByTestId("clear-job-filters").waitFor({ state: "detached" });
  assert.equal(await page.getByTestId("job-search").inputValue(), "");
  assert.equal(await page.getByTestId("recent-filter").inputValue(), "0");
  assert.equal(await page.getByLabel("Minimum salary").inputValue(), "0");
  assert.equal(await page.getByRole("button", { name: "All types", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByRole("button", { name: "Any fit", exact: true }).getAttribute("aria-pressed"), "true");

  console.log(`jobs filter UI tests passed; screenshot: ${screenshot}`);
} finally {
  await browser?.close();
  vite.kill();
}

async function waitForServer(url) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not start at ${url}`);
}

async function waitForQuery(getUrl, name, value) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const current = getUrl();
    if (current && new URL(current).searchParams.get(name) === value) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${name}=${value}; latest request was ${getUrl()}`);
}
