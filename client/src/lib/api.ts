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

async function apiFetch(path: string, init: RequestInit = {}) {
  const token = getToken();
  const headers = new Headers(init.headers || {});
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const r = await fetch(API_BASE + path, { ...init, headers, credentials: "include" });
  const text = await r.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!r.ok) {
    const err = new Error(`${r.status} ${path} ${body?.error || body?.message || ""}`);
    (err as any).status = r.status;
    (err as any).body = body;
    throw err;
  }
  return body;
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
  triggerScrape:() => apiFetch("/api/admin/cron/scrape", { method: "POST" }),
  triggerScore: () => apiFetch("/api/admin/cron/score",  { method: "POST" }),

  // Applications
  applications:        (status?: string) => apiFetch("/api/admin/applications" + (status ? "?status=" + encodeURIComponent(status) : "")),
  draftApplication:    (job_id: number) => apiFetch("/api/admin/applications", { method: "POST", body: JSON.stringify({ job_id }) }),
  getApplication:      (id: number) => apiFetch(`/api/admin/applications/${id}`),
  updateApplication:   (id: number, patch: any) => apiFetch(`/api/admin/applications/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  submitApplication:   (id: number) => apiFetch(`/api/admin/applications/${id}/submit`, { method: "POST" }),
  withdrawApplication: (id: number) => apiFetch(`/api/admin/applications/${id}`, { method: "DELETE" }),
};