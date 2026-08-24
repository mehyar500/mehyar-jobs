import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useToast } from "../lib/toast";

// Today — daily-scrape tracker.
//
// Three sections, in priority order:
//   1. 🆕 New today   (jobs first seen in the last `days`)
//   2. ✅ Submitted   (any application.status = 'submitted')
//   3. ⏳ Not yet submitted  (today's new jobs with no submitted application)
//
// Manual mark: per row in section 1 + 3, two buttons:
//   • Mark applied          → POST /api/admin/jobs/{id}/mark { action: "applied" }
//   • Mark applied externally → POST /api/admin/jobs/{id}/mark { action: "applied_external", url? }
//   • Skip                  → POST /api/admin/jobs/{id}/mark { action: "skipped" }
//
// Auth: same JWT as the rest of the app.

type View = "recent_all" | "not_submitted" | "new_today" | "submitted";

export default function Today() {
  const qc = useQueryClient();
  const toast = useToast();
  const [days, setDays] = useState(7);
  const [view, setView] = useState<View>("recent_all");
  const [minFit, setMinFit] = useState(0);
  const [marking, setMarking] = useState<number | null>(null);

  const todayQ = useQuery({
    queryKey: ["today", days],
    queryFn: () => api.today(days),
    refetchInterval: 30_000,
  });

  const statsQ = useQuery({
    queryKey: ["public-stats"],
    queryFn: () => api.publicStats(),
    refetchInterval: 60_000,
  });

  // Pending assisted-apply queue — the user's "today's to-do" list.
  // Same role as a daily-digest email: shows which auto-applies still
  // need to be submitted manually on the company site.
  const queueQ = useQuery({
    queryKey: ["assisted-queue"],
    queryFn: () => api.assistedQueue(),
    refetchInterval: 30_000,
  });

  const filterFn = (j: any) => minFit === 0 || (j.score != null && j.score >= minFit);

  const items = useMemo<any[]>(() => {
    const v = todayQ.data;
    if (!v) return [];
    if (view === "recent_all")     return (v.recent_all   || []).filter(filterFn);
    if (view === "new_today")      return (v.new_today    || []).filter(filterFn);
    if (view === "submitted")      return (v.submitted    || []).filter(filterFn);
    return (v.not_submitted || []).filter(filterFn);
  }, [todayQ.data, view, minFit]);

  const mark = async (jobId: number, action: "applied" | "applied_external" | "skipped", extra?: any) => {
    setMarking(jobId);
    try {
      await api.markJob(jobId, { action, ...(extra || {}) });
      toast.push({ kind: "success", title: action === "applied" ? "✅ Marked applied" : action === "applied_external" ? "🔗 Marked applied (external)" : "🚫 Skipped", message: "Updated. Refreshes in a few seconds." });
      qc.invalidateQueries({ queryKey: ["today"] });
      qc.invalidateQueries({ queryKey: ["applications"] });
    } catch (e: any) {
      toast.push({ kind: "error", title: "Mark failed", message: e?.body?.error || e?.message });
    } finally {
      setMarking(null);
    }
  };

  const triggerRescan = async () => {
    try {
      toast.push({ kind: "info", title: "Rescanning…", message: "Daily scrape + score in progress." });
      await api.triggerFullScrape();
      qc.invalidateQueries({ queryKey: ["today"] });
      qc.invalidateQueries({ queryKey: ["public-stats"] });
      toast.push({ kind: "success", title: "Rescan complete", message: "Fresh jobs loaded." });
    } catch (e: any) {
      toast.push({ kind: "error", title: "Rescan failed", message: e?.body?.error || e?.message });
    }
  };

  const lastRun = todayQ.data?.last_run;
  const counters = todayQ.data?.counters || {};
  const updatedAt = todayQ.data?.updated_at;

  return (
    <div className="col" style={{ gap: 16 }}>
      {/* Header */}
      <div className="card">
        <div className="between wrap" style={{ gap: 12 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h1 className="h1">📅 Today's jobs</h1>
            <p className="sm muted" style={{ marginTop: 4 }}>
              Daily scrape of Fortune 500 + Forbes 2000 + Inc 5000 + S&P 500 + YC + Wellfound.
              Mark items manually as you apply.
            </p>
          </div>
          <div className="row">
            <button className="btn btn-primary" onClick={triggerRescan} data-testid="today-rescan-btn">
              🔄 Rescan now
            </button>
          </div>
        </div>

        <div className="grid grid-4" style={{ marginTop: 12 }}>
          <Stat label="Active jobs total" value={(statsQ.data as any)?.jobs ?? "—"} sub={`${(statsQ.data as any)?.companies ?? 0} companies`} />
          <Stat label="New (last 24h)" value={counters.new_in_window ?? "—"} accent="var(--accent)" sub={`${counters.not_submitted ?? 0} not submitted`} />
          <Stat label="Submitted today" value={counters.submitted_today ?? "—"} accent="var(--good)" sub={`${counters.submitted_this_window ?? 0} this window`} />
          <Stat label="Last scrape" value={lastRun?.finished_at ? relativeTime(lastRun.finished_at) : "—"} sub={lastRun?.new_jobs != null ? `+${lastRun.new_jobs} new` : ""} />
        </div>

      </div>

      {/* 🤖 Assisted-apply queue — replaces the daily-digest email */}
      {queueQ.data?.ok && queueQ.data?.count > 0 ? (
        <div className="card" style={{ borderColor: "var(--accent)" }}>
          <div className="row between wrap" style={{ gap: 8 }}>
            <div>
              <h2 className="h2" style={{ margin: 0 }}>🤖 {queueQ.data.pending_count} assisted applies waiting for you</h2>
              <p className="sm muted" style={{ marginTop: 4 }}>
                These were drafted automatically (CF Browser Rendering is not enabled on this account, so the 🤖 button prepares the answers instead of submitting for you). Open each link, paste the prepared values, click submit on the company site.
              </p>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => queueQ.refetch()} disabled={queueQ.isFetching}>
              {queueQ.isFetching ? "loading…" : "↻ refresh"}
            </button>
          </div>

          <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
            {queueQ.data.items.map((q: any) => (
              <div
                key={q.app_id}
                className="card card-tight"
                style={{ padding: 12, borderColor: q.status === "auto_submitted_pending" ? "var(--accent)" : "var(--border)" }}
              >
                <div className="row between wrap" style={{ gap: 8 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="row" style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <strong>{(q.job.title || "").slice(0, 60)}</strong>
                      <span className="badge" style={{ background: "var(--accent)", color: "#fff", fontSize: 10 }}>fit {q.fit.score ?? "—"}</span>
                      <span className="xs muted">{q.company.name}</span>
                    </div>
                    <div className="xs muted" style={{ marginTop: 4 }}>
                      app #{q.app_id} · {q.job.location || "—"} · {q.job.remote_policy || "—"} ·{" "}
                      {q.status === "auto_submitted_pending" ? "🤖 awaits your click" :
                       q.status === "submitted" ? "✅ submitted — awaiting company reply" :
                       q.status === "confirmed" ? "🎉 confirmed by company" :
                       q.status}
                      {q.tracking_email ? ` · reply to ${q.tracking_email}` : ""}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 6, flexShrink: 0 }}>
                    <a className="btn btn-primary btn-sm" href={q.job.url} target="_blank" rel="noreferrer">
                      ↗ Open & submit
                    </a>
                  </div>
                </div>

                {/* Show prepared form values + LLM answers inline */}
                {Object.keys(q.form_filled || {}).length > 0 || (q.custom_answers || []).length > 0 ? (
                  <details style={{ marginTop: 8 }}>
                    <summary className="sm">
                      Prepared values ({Object.keys(q.form_filled || {}).length} form + {(q.custom_answers || []).length} LLM)
                    </summary>
                    <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
                      {Object.entries(q.form_filled || {}).slice(0, 8).map(([k, v]: any) => (
                        <div key={k} className="xs" style={{ display: "flex", gap: 6 }}>
                          <code style={{ minWidth: 100, color: "var(--accent)" }}>{k}</code>
                          <span> = <strong>{String(v?.value ?? "").slice(0, 200)}</strong> <span className="muted">[{v?.source || ""}]</span></span>
                        </div>
                      ))}
                      {(q.custom_answers || []).slice(0, 5).map((a: any, i: number) => (
                        <div key={i} className="xs" style={{ borderTop: "1px solid var(--border)", paddingTop: 6, marginTop: 6 }}>
                          <div className="muted mono">{a.field || a.label || `Answer ${i+1}`}</div>
                          <div style={{ marginTop: 2, whiteSpace: "pre-wrap" }}>{String(a.answer || "").slice(0, 500)}</div>
                        </div>
                      ))}
                    </div>
                  </details>
                ) : null}

                {/* Email status — truthful */}
                {q.email.attempted ? (
                  <div className="xs" style={{ marginTop: 6 }}>
                    email: {q.email.last_status === "sent" ? "✅ sent" :
                            q.email.last_status === "failed" ? `❌ failed (${q.email.last_error || "no provider"})` :
                            q.email.last_status}
                    {q.email.last_status === "failed" ? (
                      <span className="muted"> — Resend API key isn't configured; this in-app queue is your notification.</span>
                    ) : null}
                  </div>
                ) : (
                  <div className="xs muted" style={{ marginTop: 6 }}>
                    email: not attempted (this in-app queue IS your notification)
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Old header end */}
      {lastRun && (
          <div className="row wrap sm muted" style={{ marginTop: 10, gap: 10 }}>
            <span className="tag tag-zinc xs">{lastRun.companies_succeeded}/{lastRun.companies_attempted} companies ok</span>
            <span className="tag tag-zinc xs">{lastRun.jobs_found} found</span>
            <span className="tag tag-zinc xs">{lastRun.new_jobs} new</span>
            <span className="tag tag-zinc xs">{lastRun.removed_jobs} removed</span>
            <span className="tag tag-zinc xs">{Math.round((lastRun.duration_ms || 0) / 1000)}s</span>
            <span className="grow" />
            <span className="xs muted">refreshed {updatedAt ? relativeTime(updatedAt) : "—"}</span>
          </div>
      )}

      {/* View toggle + window */}
      <div className="card card-tight">
        <div className="row wrap" style={{ gap: 8 }}>
          <div className="row" style={{ gap: 4 }}>
            {([
              ["recent_all",    "🕒 Recent posts", counters.recent_all ?? (statsQ.data as any)?.jobs ?? 0],
              ["not_submitted", "⏳ Not submitted", counters.not_submitted ?? 0],
              ["new_today",     "🆕 New today",     counters.new_in_window ?? 0],
              ["submitted",     "✅ Submitted",     counters.submitted_this_window ?? 0],
            ] as [View, string, number][]).map(([k, label, n]) => (
              <button
                key={k}
                className={`tab ${view === k ? "active" : ""}`}
                onClick={() => setView(k)}
                data-testid={`today-view-${k}`}
              >
                {label} <span className="dim xs">({n})</span>
              </button>
            ))}
          </div>

          <span className="grow" />

          <span className="row xs muted" style={{ gap: 4 }}>
            window:
            {[1, 3, 7, 14].map((d) => (
              <button key={d} className={`tab ${days === d ? "active" : ""}`} onClick={() => setDays(d)}>
                {d === 1 ? "24h" : d === 7 ? "1w" : d === 14 ? "2w" : `${d}d`}
              </button>
            ))}
          </span>

          <span className="row xs muted" style={{ gap: 4 }}>
            fit ≥
            {[0, 50, 70, 90].map((n) => (
              <button key={n} className={`tab ${minFit === n ? "active" : ""}`} onClick={() => setMinFit(n)}>
                {n === 0 ? "all" : n}
              </button>
            ))}
          </span>
        </div>
      </div>

      {/* Body */}
      <div className="card card-tight" style={{ padding: 0 }}>
        {todayQ.isLoading ? (
          <div className="col" style={{ padding: 16, gap: 8 }}>
            {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skel" />)}
          </div>
        ) : items.length === 0 ? (
          <EmptyState view={view} onRescan={triggerRescan} />
        ) : (
          <table className="responsive-table">
            <thead>
              <tr>
                <th style={{ width: 52 }}>Fit</th>
                <th>Title</th>
                <th>Company</th>
                <th>Location</th>
                <th style={{ width: 90 }}>{view === "submitted" ? "Submitted" : "Added"}</th>
                <th style={{ width: 220 }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {items.map((j: any) => (
                <TodayRow
                  key={`${view}-${j.id}-${j.application_id || 0}`}
                  row={j}
                  view={view}
                  busy={marking === j.id}
                  onMark={mark}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function TodayRow({ row, view, busy, onMark }: { row: any; view: View; busy: boolean; onMark: (id: number, action: "applied" | "applied_external" | "skipped", extra?: any) => void }) {
  const score = row.score;
  const cls = score == null ? "fit-0" : score >= 90 ? "fit-90" : score >= 70 ? "fit-70" : score >= 50 ? "fit-50" : score >= 30 ? "fit-30" : "fit-0";
  const titleStr = row.title || "Untitled role";
  const url = row.url || "#";
  const ts = view === "submitted" ? row.submitted_at : (row.posted_at || row.first_seen_at);

  return (
    <tr>
      <td className="fit-col" data-label="Fit">
        <span className={`fit-chip ${cls}`}>{score ?? "—"}</span>
      </td>
      <td data-label="Title">
        <a href={url} target="_blank" rel="noreferrer" style={{ color: "inherit", textDecoration: "none" }}>
          <div className="h3">{titleStr}</div>
          {row.department ? <div className="xs dim">{row.department}</div> : null}
        </a>
      </td>
      <td data-label="Company">
        <a href={`/companies?q=${encodeURIComponent(row.company_name || "")}`} style={{ color: "inherit", textDecoration: "none" }}>
          <span>{row.company_name || "—"}</span>
          {row.industry ? <span className="tag tag-zinc xs" style={{ marginLeft: 4 }}>{row.industry}</span> : null}
        </a>
      </td>
      <td data-label="Location" className="sm">
        <div className="row" style={{ flexWrap: "wrap" }}>
          {row.location || <span className="dim">—</span>}
          {row.remote_policy && row.remote_policy !== "unknown" ? <span className={`tag tag-${row.remote_policy === "remote" ? "emerald" : row.remote_policy === "hybrid" ? "sky" : "zinc"} xs`}>{row.remote_policy}</span> : null}
        </div>
      </td>
      <td data-label="When" className="sm dim">{relativeTime(ts)}</td>
      <td data-label="Action">
        <ActionCell row={row} view={view} busy={busy} onMark={onMark} />
      </td>
    </tr>
  );
}

function ActionCell({ row, view, busy, onMark }: { row: any; view: View; busy: boolean; onMark: (id: number, action: "applied" | "applied_external" | "skipped", extra?: any) => void }) {
  const [confirmSkip, setConfirmSkip] = useState(false);

  if (view === "submitted") {
    return (
      <div className="apply-sticky">
        <span className="status-pill submitted" data-testid={`today-applied-${row.job_id}`}>✓ applied</span>
        {row.tracking_email ? (
          <div className="xs dim mono" style={{ marginTop: 4 }} title="tracking email">
            {row.tracking_email}
          </div>
        ) : null}
        <a href={`/applications/${row.id}`} className="btn btn-ghost btn-sm" style={{ marginTop: 4, textDecoration: "none" }}>View</a>
      </div>
    );
  }

  // Already applied (in case user navigates here from new_today while the row has an existing app)
  if (row.application_status === "submitted") {
    return (
      <div className="apply-sticky">
        <span className="status-pill submitted">✓ applied</span>
      </div>
    );
  }

  // Draft or skipped/failed
  return (
    <div className="apply-sticky">
      <div className="row" style={{ gap: 4 }}>
        <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => onMark(row.id, "applied")} data-testid={`today-mark-${row.id}`}>
          {busy ? <span className="spinner" /> : "✅"} applied
        </button>
        <a className="btn btn-sm" href={row.url} target="_blank" rel="noreferrer" title="Open the job posting in a new tab to apply manually">
          ↗ apply
        </a>
        {!confirmSkip ? (
          <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setConfirmSkip(true)} title="Mark as skipped (you decided not to apply)">
            skip
          </button>
        ) : (
          <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => { setConfirmSkip(false); onMark(row.id, "skipped"); }} data-testid={`today-skip-${row.id}`}>
            confirm skip
          </button>
        )}
      </div>
      {row.application_status === "draft" ? <div className="xs dim" style={{ marginTop: 4 }}>📝 has draft</div> : null}
      {row.application_status === "failed" ? <div className="xs" style={{ marginTop: 4, color: "var(--bad)" }}>❌ last attempt failed</div> : null}
    </div>
  );
}

function EmptyState({ view, onRescan }: { view: View; onRescan: () => void }) {
  const messages: Record<View, { emoji: string; title: string; body: string }> = {
    recent_all:    { emoji: "🤷", title: "No active jobs yet", body: "Hit Rescan to pull the latest from the directory." },
    not_submitted: { emoji: "🎉", title: "Nothing pending", body: "Every job in this window is either submitted or skipped. Run a fresh scan to see more." },
    new_today:     { emoji: "🤷", title: "No new jobs",     body: "No jobs were first-seen in this window. Hit Rescan to pull the latest." },
    submitted:     { emoji: "📭", title: "No submissions yet", body: "Mark a job as applied to see it here." },
  };
  const m = messages[view];
  return (
    <div className="col" style={{ padding: 32, textAlign: "center", gap: 8 }}>
      <span style={{ fontSize: 36 }}>{m.emoji}</span>
      <h2 className="h2">{m.title}</h2>
      <p className="sm muted">{m.body}</p>
      <button className="btn btn-primary" onClick={onRescan}>🔄 Rescan now</button>
    </div>
  );
}

function Stat({ label, value, sub, accent }: { label: string; value: any; sub?: string; accent?: string }) {
  return (
    <div className="stat">
      <div className="xs muted">{label}</div>
      <div className="h2" style={{ marginTop: 4, color: accent || "inherit" }}>{value}</div>
      {sub ? <div className="xs dim" style={{ marginTop: 2 }}>{sub}</div> : null}
    </div>
  );
}

function relativeTime(s?: string | null) {
  if (!s) return "—";
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return s;
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
