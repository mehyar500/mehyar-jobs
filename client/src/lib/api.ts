// Shared API helper + auth token from a single source of truth.
//
// Auth: the JWT is shared with mehyar-web via cookie `admin_session`
// OR via Authorization: Bearer header. We grab it once at boot and
// stash it in localStorage so we survive page reloads. The login form
// here accepts the same username/password as mehyar-web /admin, posts
// to mehyar-web's /api/admin/auth/login, and saves the returned token.

const TOKEN_KEY = "mehyar_jobs_token_v1";
const PRINCIPAL_KEY = "mehyar_jobs_principal_v1";

export function getToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}
export function setToken(t: string, principal?: any) {
  try {
    localStorage.setItem(TOKEN_KEY, t);
    if (principal) localStorage.setItem(PRINCIPAL_KEY, JSON.stringify(principal));
  } catch {}
}
export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(PRINCIPAL_KEY);
  } catch {}
}
export function getPrincipal(): any | null {
  try { return JSON.parse(localStorage.getItem(PRINCIPAL_KEY) || "null"); } catch { return null; }
}

// API base: same origin during dev/prod.
export const API_BASE = "";

// Auth endpoints on jobs.mehyar.us (same-origin, no CORS preflight).
// The token issued here verifies on both mehyar-web and mehyar-jobs
// because both apps share ADMIN_SESSION_SECRET.
const LOGIN_URL = "/api/auth/login";

export async function login(username: string, password: string) {
  const r = await fetch(LOGIN_URL, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`login failed (${r.status}) ${txt.slice(0, 200)}`);
  }
  const j = await r.json();
  if (!(j as any)?.token) throw new Error("login: missing token in response");
  setToken((j as any).token, { sub: username, exp: (j as any).expiresAt });
  return j;
}

async function apiFetch(path: string, init: RequestInit = {}): Promise<any> {
  let token = getToken();
  const headers = new Headers(init.headers || {});
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const r = await fetch(API_BASE + path, { ...init, headers, credentials: "include" });
  const text = await r.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }

  // Auto-handle expired tokens: clear and notify the app so it can re-login.
  // Without this, every admin endpoint silently returns 401 and the page
  // looks empty ("0 jobs shown").
  if (!r.ok && (r.status === 401 || body?.error === "expired" || body?.error === "missing_token" || body?.error === "bad_signature")) {
    clearToken();
    window.dispatchEvent(new CustomEvent("mehyar:auth-expired", { detail: { path, status: r.status, body } }));
    const err = new Error(`${r.status} ${path} ${body?.error || body?.message || ""}`);
    (err as any).status = r.status;
    (err as any).body = body;
    (err as any).expired = true;
    throw err;
  }

  if (!r.ok) {
    const err = new Error(`${r.status} ${path} ${body?.error || body?.message || ""}`);
    (err as any).status = r.status;
    (err as any).body = body;
    throw err;
  }
  return body;
}

export async function runFullScrape(onProgress?: (progress: any) => void) {
  let cursor = 0;
  let batches = 0;
  const total = { attempted: 0, succeeded: 0, failed: 0, jobs_found: 0, new_jobs: 0, removed_jobs: 0, contract_jobs: 0 };
  while (batches < 100) {
    const batch = await apiFetch("/api/admin/cron/scrape", {
      method: "POST",
      body: JSON.stringify({ cursor, limit: 3, include_contracts: batches === 0 }),
    });
    batches += 1;
    total.attempted += Number(batch.attempted || 0);
    total.succeeded += Number(batch.succeeded || 0);
    total.failed += Number(batch.failed || 0);
    total.jobs_found += Number(batch.jobs_found || 0);
    total.new_jobs += Number(batch.new_jobs || 0);
    total.removed_jobs += Number(batch.removed_jobs || 0);
    if (batch.contracts) total.contract_jobs = Number(batch.contracts.found || 0);
    onProgress?.({ ...total, batches, done: !!batch.done });
    if (batch.done) return { ok: true, ...total, batches };
    if (!batch.next_cursor || Number(batch.next_cursor) === cursor) throw new Error("scan cursor did not advance");
    cursor = Number(batch.next_cursor);
  }
  throw new Error("scan exceeded the 100-batch safety limit");
}

export async function runFullScore(onProgress?: (progress: any) => void) {
  let cursor = 0;
  let batches = 0;
  const total = { scored: 0, hard_no: 0, top: 0, alerts_created: 0 };
  while (batches < 100) {
    const batch = await apiFetch("/api/admin/cron/score", {
      method: "POST",
      body: JSON.stringify({ cursor, limit: 300 }),
    });
    batches += 1;
    total.scored += Number(batch.scored || 0);
    total.hard_no += Number(batch.hard_no || 0);
    total.top += Number(batch.top || 0);
    total.alerts_created += Number(batch.alerts_created || 0);
    onProgress?.({ ...total, batches, done: !!batch.done });
    if (batch.done) return { ok: true, ...total, batches };
    if (!batch.next_cursor || Number(batch.next_cursor) === cursor) throw new Error("score cursor did not advance");
    cursor = Number(batch.next_cursor);
  }
  throw new Error("scoring exceeded the 100-batch safety limit");
}

export const api = {
  // Public
  publicHealth: () => fetch(API_BASE + "/api/public/health").then((r) => r.json()),
  publicStats:  () => fetch(API_BASE + "/api/public/stats").then((r) => r.json()),

  // Auth-required
  profile:      () => apiFetch("/api/admin/profile"),
  saveProfile:  (p: any) => apiFetch("/api/admin/profile", { method: "POST", body: JSON.stringify(p) }),
  companies:    (q: any = {}) => apiFetch("/api/admin/companies?" + new URLSearchParams(q).toString()),
  jobs:         (q: any = {}) => apiFetch("/api/admin/jobs?" + new URLSearchParams(q).toString()),
  triggerScrape:(body: any = {}) => apiFetch("/api/admin/cron/scrape", { method: "POST", body: JSON.stringify(body) }),
  triggerFullScrape: (onProgress?: (progress: any) => void) => runFullScrape(onProgress),
  triggerScore: () => apiFetch("/api/admin/cron/score",  { method: "POST" }),
  triggerFullScore: (onProgress?: (progress: any) => void) => runFullScore(onProgress),
  pipeline:     () => apiFetch("/api/admin/pipeline"),
  today:         (days = 1) => apiFetch(`/api/admin/today?days=${days}`),
  markJob:       (job_id: number, body: { action: "applied" | "applied_external" | "skipped"; url?: string; note?: string }) =>
                   apiFetch(`/api/admin/jobs/${job_id}/mark`, { method: "POST", body: JSON.stringify(body) }),

  // Applications
  applications:        (status?: string) => apiFetch("/api/admin/applications" + (status ? "?status=" + encodeURIComponent(status) : "")),
  draftApplication:    (job_id: number) => apiFetch("/api/admin/applications", { method: "POST", body: JSON.stringify({ job_id }) }),
  getApplication:      (id: number) => apiFetch(`/api/admin/applications/${id}`),
  updateApplication:   (id: number, patch: any) => apiFetch(`/api/admin/applications/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  submitApplication:   (id: number) => apiFetch(`/api/admin/applications/${id}/submit`, { method: "POST" }),
  confirmApplication:  (id: number, subject?: string) => apiFetch(`/api/admin/applications/${id}/confirm`, { method: "POST", body: JSON.stringify(subject ? { subject } : {}) }),
  unconfirmApplication:(id: number) => apiFetch(`/api/admin/applications/${id}/confirm`, { method: "DELETE" }),
  withdrawApplication: (id: number) => apiFetch(`/api/admin/applications/${id}`, { method: "DELETE" }),
  autoSubmit:          (id: number) => apiFetch(`/api/admin/applications/${id}/auto-submit`, { method: "POST", body: JSON.stringify({ confirm: true }) }),
  bulkAutoApply:       (body: any) => apiFetch(`/api/admin/applications/bulk-auto-submit`, { method: "POST", body: JSON.stringify(body) }),
  applyTop:            (body: any) => apiFetch(`/api/admin/applications/apply-top`, { method: "POST", body: JSON.stringify(body) }),
  assistedQueue:       () => apiFetch(`/api/admin/assisted-queue`),
  getAutoSubmitRun:    (id: number) => apiFetch(`/api/admin/applications/${id}/auto-submit`),
  formFill:            (id: number, fields: any[], screenshot?: string) => apiFetch(`/api/admin/applications/${id}/form-fill`, { method: "POST", body: JSON.stringify({ fields, screenshot }) }),
  recordLocalRun:       (id: number, run: any) => apiFetch(`/api/admin/applications/${id}/local-run`, { method: "POST", body: JSON.stringify(run) }),
  // Queue (max 50/day, dedup)
  getQueue:            (status?: string) => apiFetch("/api/admin/applications/queue" + (status ? "?status=" + encodeURIComponent(status) : "")),
  enqueue:             (body: { job_ids?: number[]; fit_min?: number; max?: number; run_now?: boolean }) =>
                         apiFetch("/api/admin/applications/queue", { method: "POST", body: JSON.stringify(body) }),
  exportApplicationsCSV: () => {
    const token = getToken();
    return fetch("/api/admin/applications/export.csv", { headers: token ? { authorization: `Bearer ${token}` } : {}, credentials: "include" })
      .then((r) => { if (!r.ok) throw new Error("export failed: " + r.status); return r.blob(); });
  },
  getDigest:           (days = 1) => apiFetch(`/api/admin/digest?days=${days}`),
  sendDigest:          () => apiFetch(`/api/admin/digest`, { method: "POST" }),
};
