import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useToast } from "../lib/toast";

function fitClass(score?: number | null) {
  if (score == null) return "fit-0";
  if (score >= 90) return "fit-90";
  if (score >= 70) return "fit-70";
  if (score >= 50) return "fit-50";
  if (score >= 30) return "fit-30";
  return "fit-0";
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

type ApplyStage = "idle" | "drafting" | "submitting" | "submitted" | "error";

export default function Jobs() {
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [industry, setIndustry] = useState("");
  const [remote, setRemote] = useState("");
  const [fitMin, setFitMin] = useState(0);
  const [sort, setSort] = useState<"fit" | "recent" | "company">("fit");
  const [showHardNo, setShowHardNo] = useState(true);
  const [scraping, setScraping] = useState(false);
  const [scoring, setScoring] = useState(false);
  const [applyStage, setApplyStage] = useState<Record<number, ApplyStage>>({});
  const [draftResult, setDraftResult] = useState<any | null>(null);
  const [autoRun, setAutoRun] = useState<any | null>(null);
  const [autoRunning, setAutoRunning] = useState<number | null>(null);

  const params = useMemo(() => {
    const p: any = { sort, fit_min: fitMin };
    if (q) p.q = q;
    if (industry) p.industry = industry;
    if (remote) p.remote = remote;
    if (showHardNo) p.include_hard_no = 1;
    return p;
  }, [q, industry, remote, fitMin, sort, showHardNo]);

  const jobsQ = useQuery({
    queryKey: ["jobs", params],
    queryFn: () => api.jobs(params),
    refetchInterval: 60_000,
  });
  const statsQ = useQuery({
    queryKey: ["public-stats"],
    queryFn: () => api.publicStats(),
    refetchInterval: 60_000,
  });
  const appsQ = useQuery({
    queryKey: ["applications"],
    queryFn: () => api.applications(),
    refetchInterval: 30_000,
  });

  const items: any[] = jobsQ.data?.items || [];
  const total = jobsQ.data?.total || 0;
  const facets: any[] = jobsQ.data?.facets || [];
  const appsByJob: Record<number, any> = useMemo(() => {
    const m: Record<number, any> = {};
    for (const a of appsQ.data?.items || []) m[a.job_id] = a;
    return m;
  }, [appsQ.data]);

  const triggerRescan = async () => {
    setScraping(true);
    try {
      toast.push({ kind: "info", title: "Rescanning all companies…", message: "This takes ~60-90s for the full directory.", duration: 4000 });
      await api.triggerScrape();
      setScoring(true);
      try { await api.triggerScore(); } finally { setScoring(false); }
      qc.invalidateQueries({ queryKey: ["jobs"] });
      qc.invalidateQueries({ queryKey: ["public-stats"] });
      qc.invalidateQueries({ queryKey: ["applications"] });
      toast.push({ kind: "success", title: "Rescan complete", message: "Fresh jobs + scores loaded." });
    } catch (e: any) {
      toast.push({ kind: "error", title: "Rescan failed", message: e?.body?.error || e?.message });
    } finally {
      setScraping(false); setScoring(false);
    }
  };

  const startApply = async (jobId: number) => {
    setApplyStage((s) => ({ ...s, [jobId]: "drafting" }));
    try {
      const r = await api.draftApplication(jobId);
      setDraftResult(r);
      qc.invalidateQueries({ queryKey: ["applications"] });
      setApplyStage((s) => ({ ...s, [jobId]: "idle" }));
    } catch (e: any) {
      setApplyStage((s) => ({ ...s, [jobId as number]: "error" }));
      toast.push({ kind: "error", title: "Could not generate draft", message: e?.body?.error || e?.message });
    }
  };

  const submitApply = async (id: number, jobId?: number) => {
    setApplyStage((s) => ({ ...s, [jobId as number]: "submitting" }));
    setDraftResult(null);
    try {
      const r = await api.submitApplication(id);
      setApplyStage((s) => ({ ...s, [jobId as number]: "submitted" }));
      qc.invalidateQueries({ queryKey: ["applications"] });
      qc.invalidateQueries({ queryKey: ["jobs"] });

      // Two toasts: one for the app log, one for the real company email
      toast.push({
        kind: "success",
        title: `✅ Applied to ${r.id ? "" : ""}${r.submission_url ? "" : "job"}`,
        message: "Logged in your Applications. Open the job URL in a new tab to complete the company form.",
        actions: [
          { label: "Open job ↗", href: r.submission_url, onClick: undefined },
          { label: "View", href: `/applications/${r.id}` },
        ],
        duration: 10000,
      });
      if (r.email?.sent) {
        toast.push({
          kind: "info",
          title: "📧 Confirmation email sent",
          message: "Check your inbox — once you submit on the company's site, they'll send the real 'thank you' email too.",
          duration: 6000,
        });
      } else if (r.email?.error && r.email.error !== "email_no_binding" && r.email.error !== "email_not_configured") {
        toast.push({
          kind: "error",
          title: "Email failed",
          message: r.email.error,
        });
      }
    } catch (e: any) {
      setApplyStage((s) => ({ ...s, [jobId as number]: "error" }));
      toast.push({ kind: "error", title: "Submit failed", message: e?.body?.error || e?.message });
    }
  };

  const autoApply = async (jobId: number) => {
      setAutoRunning(jobId);
      setAutoRun({ status: "running", applicationId: appsByJob[jobId]?.id || null });
      try {
        const app = appsByJob[jobId] || await api.draftApplication(jobId);
        setAutoRun({ status: "running", applicationId: app.id });
        const r = await api.autoSubmit(app.id);
        // Surface "assisted" mode distinctly so the viewer can render
        // the prepared form answers + a clear next-step CTA.
        const title = r?.mode === "assisted"
          ? "Assisted apply ready — open the job URL and paste the answers"
          : "Auto-apply run finished";
        setAutoRun({ status: "show", ...r });
        qc.invalidateQueries({ queryKey: ["applications"] });
        qc.invalidateQueries({ queryKey: ["jobs"] });
        toast.push({ kind: "success", title, message: r?.message || "Review the captured result before relying on the submission." });
      } catch (e: any) {
        setAutoRun(null);
        toast.push({ kind: "error", title: "Auto-apply failed", message: e?.body?.error || e?.message });
      } finally {
        setAutoRunning(null);
      }
    };

  return (
    <div className="col" style={{ gap: 16 }}>
      {/* Banner */}
      <div className="card">
        <div className="between wrap" style={{ gap: 12 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h1 className="h1">🎯 Top careers, ranked by fit</h1>
            <p className="sm muted" style={{ marginTop: 4 }}>
              Daily scan of Fortune 500 + Forbes 2000 + Inc 5000 + S&P 500 + Y Combinator + Wellfound. Zero API keys.
            </p>
          </div>
          <div className="row">
            <button className="btn btn-primary" onClick={triggerRescan} disabled={scraping || scoring} data-testid="rescan-btn">
              {scraping ? <><span className="spinner" /> scraping…</>
                : scoring ? <><span className="spinner" /> scoring…</>
                : "🔄 Rescan + Score now"}
            </button>
          </div>
        </div>
        <div className="grid grid-4" style={{ marginTop: 12 }}>
          <Stat label="Companies" value={(statsQ.data as any)?.companies ?? "—"} />
          <Stat label="Active jobs" value={(statsQ.data as any)?.jobs ?? "—"} />
          <Stat label="Last scrape" value={(statsQ.data as any)?.last_scrape_at ? relativeTime((statsQ.data as any).last_scrape_at) : "never"} />
          <Stat label="Total runs" value={(statsQ.data as any)?.scrape_runs ?? "—"} />
        </div>
      </div>

      {/* Auto-submit result viewer */}
      {autoRun && autoRun.status === "show" && autoRun.screenshot_base64 && (
        <AutoSubmitViewer run={autoRun} onClose={() => setAutoRun(null)} />
      )}
      {autoRun && autoRun.status === "running" && (
        <div className="card" style={{ borderColor: "var(--accent)" }}>
          <div className="row" style={{ gap: 10 }}>
            <span className="spinner" style={{ width: 18, height: 18 }} />
            <strong>🤖 Auto-applying in headless browser…</strong>
          </div>
          <p className="sm muted" style={{ marginTop: 8 }}>
            Opening {autoRun.applicationId ? "the application form" : "the job page"} in a real Chromium instance, filling the fields, uploading your resume, and clicking submit.
            This can take 15-45 seconds.
          </p>
        </div>
      )}

      {/* Draft preview */}
      {draftResult && (
        <DraftPreview
          draft={draftResult}
          onClose={() => setDraftResult(null)}
          onSubmit={submitApply}
        />
      )}

      {/* Filters */}
      <div className="card">
        <div className="grid" style={{ gridTemplateColumns: "2fr 1fr 1fr 1fr" }}>
          <input type="search" placeholder="Search title / company / description…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={industry} onChange={(e) => setIndustry(e.target.value)}>
            <option value="">all industries</option>
            {facets.map((f: any) => (
              <option key={f.industry} value={f.industry}>{f.industry || "(none)"} ({f.n})</option>
            ))}
          </select>
          <select value={remote} onChange={(e) => setRemote(e.target.value)}>
            <option value="">any location</option>
            <option value="remote">remote</option>
            <option value="hybrid">hybrid</option>
            <option value="onsite">on-site</option>
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value as any)}>
            <option value="fit">sort: fit score</option>
            <option value="recent">sort: recently added</option>
            <option value="company">sort: company (A→Z)</option>
          </select>
        </div>
        <div className="row wrap" style={{ marginTop: 10, gap: 6 }}>
          <span className="xs muted">fit ≥</span>
          {[0, 30, 50, 70, 90].map((n) => (
            <button key={n} className={`tab ${fitMin === n ? "active" : ""}`} onClick={() => setFitMin(n)}>{n === 0 ? "all" : n}</button>
          ))}
          <span className="xs muted" style={{ marginLeft: 12 }}>·</span>
          <label className="row xs">
            <input type="checkbox" checked={showHardNo} onChange={(e) => setShowHardNo(e.target.checked)} />
            <span className="muted">include hard-no</span>
          </label>
          <span className="grow" />
          <span className="xs muted">{total.toLocaleString()} jobs · {items.length} shown · v2026-07-28</span>
        </div>
      </div>

      {/* Mobile: applied-to summary */}
      <MobileAppliedSummary appsQ={appsQ} />

      {/* Table */}
      <div className="card card-tight" style={{ padding: 0 }}>
        {jobsQ.isLoading ? (
          <div className="col" style={{ padding: 16, gap: 8 }}>
            {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skel" />)}
          </div>
        ) : jobsQ.isError ? (
          <div className="col" style={{ padding: 32, textAlign: "center", gap: 8 }}>
            <span style={{ fontSize: 36 }}>⚠️</span>
            <h2 className="h2">Could not load jobs</h2>
            <p className="sm muted">{(jobsQ.error as any)?.body?.error || (jobsQ.error as any)?.message || "Unknown error"}</p>
            <button className="btn btn-primary" onClick={() => jobsQ.refetch()}>Retry</button>
          </div>
        ) : items.length === 0 ? (
          <div className="col" style={{ padding: 32, textAlign: "center", gap: 8 }}>
            <span style={{ fontSize: 36 }}>🤷</span>
            <h2 className="h2">No jobs match your filters</h2>
            <p className="sm muted">Try lowering fit, clearing search, or hitting Rescan to refresh.</p>
            <button className="btn btn-primary" onClick={triggerRescan} disabled={scraping}>
              {scraping ? "scraping…" : "🔄 Rescan + Score now"}
            </button>
          </div>
        ) : (
          <table className="responsive-table">
            <thead>
              <tr>
                <th style={{ width: 56 }}>Fit</th>
                <th>Title</th>
                <th>Company</th>
                <th>Location</th>
                <th>Posted</th>
                <th style={{ width: 130 }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((j: any) => {
                const app = appsByJob[j.id];
                return (
                  <tr key={j.id}>
                    <td className="fit-col" data-label="Fit">
                      <span className={`fit-chip ${fitClass(j.score)}`} title={(j.reasons || []).join(" · ")}>
                        {j.score ?? "—"}
                      </span>
                    </td>
                    <td data-label="Title">
                                          <a
                                            href={j.url}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="job-title-link"
                                            style={{ color: "inherit", textDecoration: "none" }}
                                          >
                                            <div className="h3">{j.title}</div>
                                            {j.department ? <div className="xs dim">{j.department}{j.team ? " · " + j.team : ""}</div> : null}
                                          </a>
                                        </td>
                    <td data-label="Company">
                      <a href={`/companies?q=${encodeURIComponent(j.company_name)}`} className="row" style={{ color: "inherit", textDecoration: "none", flexWrap: "wrap" }}>
                        <span>{j.company_name}</span>
                        {j.industry ? <span className="tag tag-zinc xs" style={{ marginLeft: 4 }}>{j.industry}</span> : null}
                      </a>
                    </td>
                    <td data-label="Location">
                      <div className="row" style={{ flexWrap: "wrap" }}>
                        {j.location || <span className="dim">—</span>}
                        {j.remote_policy && j.remote_policy !== "unknown" ? <span className={`tag tag-${j.remote_policy === "remote" ? "emerald" : j.remote_policy === "hybrid" ? "sky" : "zinc"} xs`}>{j.remote_policy}</span> : null}
                      </div>
                    </td>
                    <td data-label="Posted" className="sm dim">{relativeTime(j.posted_at || j.first_seen_at)}</td>
                    <td className="action-col" data-label="Action">
                      <ApplyCell
                        job={j}
                        app={app}
                        stage={applyStage[j.id] || "idle"}
                        onApply={() => startApply(j.id)}
                        onSubmit={() => app && submitApply(app.id, j.id)}
                        onAutoApply={() => autoApply(j.id)}
                        autoRunning={autoRunning === j.id}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function MobileAppliedSummary({ appsQ }: { appsQ: any }) {
  const items: any[] = appsQ.data?.items || [];
  if (items.length === 0) return null;
  const counts = {
    draft: items.filter((a) => a.status === "draft").length,
    submitted: items.filter((a) => a.status === "submitted").length,
    failed: items.filter((a) => a.status === "failed").length,
  };
  return (
    <div className="card" style={{ display: "none" }} data-mobile-summary>
      <div className="row wrap" style={{ gap: 8 }}>
        <span className="tag tag-amber">📝 {counts.draft} draft{counts.draft === 1 ? "" : "s"}</span>
        <span className="tag tag-emerald">✅ {counts.submitted} applied</span>
        {counts.failed > 0 && <span className="tag tag-red">❌ {counts.failed} failed</span>}
        <a href="/applications" className="btn btn-ghost btn-sm" style={{ marginLeft: "auto", textDecoration: "none" }}>All →</a>
      </div>
      <style>{`@media (max-width: 720px) { [data-mobile-summary] { display: block !important; } }`}</style>
    </div>
  );
}

function ApplyCell({ job, app, stage, onApply, onSubmit, onAutoApply, autoRunning }: { job: any; app: any; stage: ApplyStage; onApply: () => void; onSubmit: () => void; onAutoApply: () => void; autoRunning: boolean }) {
  // Always-available actions: open the original job URL, and (if supported) auto-apply.
  // These appear alongside the draft/submit controls so the user is never trapped.
  const openLink = (
    <a
      href={job.url}
      target="_blank"
      rel="noreferrer"
      className="btn btn-ghost btn-sm"
      title={`Open original posting: ${job.url}`}
      data-testid={`open-${job.id}`}
      style={{ textDecoration: "none", flexShrink: 0 }}
    >
      ↗
    </a>
  );
  const autoBtn = (
    <button
      className="btn btn-ghost btn-sm"
      onClick={() => onAutoApply()}
      disabled={autoRunning}
      title="Automated apply: open headless browser, fill form, upload resume, click submit. May violate ATS ToS."
      data-testid={`auto-apply-${job.id}`}
      style={{ flexShrink: 0 }}
    >
      {autoRunning ? <span className="spinner" /> : "🤖"}
    </button>
  );

  if (stage === "drafting") {
    return (
      <div className="apply-sticky">
        <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
          <div className="progress-bar indeterminate" style={{ flex: 1 }}><div className="fill" /></div>
          <span className="xs dim" style={{ flex: 1 }}>Drafting cover letter…</span>
          {openLink}
          {autoBtn}
        </div>
      </div>
    );
  }
  if (stage === "submitting") {
    return (
      <div className="apply-sticky">
        <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
          <span className="spinner" />
          <span className="xs dim" style={{ flex: 1 }}>Submitting + sending email…</span>
          {openLink}
        </div>
      </div>
    );
  }
  if (stage === "submitted") {
    return (
      <div className="apply-sticky">
        <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
          <a href={`/applications/${app.id}`} className="status-pill submitted" style={{ textDecoration: "none", flex: 1 }}>✓ applied {app.submitted_at ? relativeTime(app.submitted_at) : ""}</a>
          {openLink}
          {autoBtn}
        </div>
      </div>
    );
  }
  if (stage === "error") {
    return (
      <div className="apply-sticky">
        <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
          <button className="btn btn-sm btn-danger" onClick={onApply} style={{ flex: 1 }}>Retry</button>
          {openLink}
          {autoBtn}
        </div>
      </div>
    );
  }
  // Idle
  if (app) {
    const status = app.status;
    if (status === "draft") {
      return (
        <div className="apply-sticky">
          <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
            <span className="status-pill draft">📝 draft</span>
            <button className="btn btn-sm btn-primary" onClick={onSubmit} data-testid={`submit-${job.id}`} style={{ flex: 1 }}>Submit & email</button>
            {openLink}
            {autoBtn}
          </div>
        </div>
      );
    }
    if (status === "submitted") {
      return (
        <div className="apply-sticky">
          <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
            <a href={`/applications/${app.id}`} className="status-pill submitted" style={{ textDecoration: "none", flex: 1 }}>✓ applied {app.submitted_at ? relativeTime(app.submitted_at) : ""}</a>
            {openLink}
            {autoBtn}
          </div>
        </div>
      );
    }
    if (status === "failed") {
      return (
        <div className="apply-sticky">
          <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
            <a href={`/applications/${app.id}`} className="status-pill failed" style={{ textDecoration: "none", flex: 1 }}>failed</a>
            {openLink}
            {autoBtn}
          </div>
        </div>
      );
    }
    if (status === "withdrawn") {
      return (
        <div className="apply-sticky">
          <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
            <span className="status-pill withdrawn" style={{ flex: 1 }}>withdrawn</span>
            {openLink}
            {autoBtn}
          </div>
        </div>
      );
    }
  }
  return (
    <div className="apply-sticky">
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <button className="btn btn-primary" onClick={onApply} data-testid={`apply-${job.id}`} style={{ flex: 1 }}>
          Apply
        </button>
        {openLink}
        {autoBtn}
      </div>
    </div>
  );
}

function DraftPreview({ draft, onClose, onSubmit }: { draft: any; onClose: () => void; onSubmit: (id: number, jobId?: number) => void }) {
  if (!draft) return null;
  if (!draft.ok) {
    return (
      <div className="card" style={{ borderColor: "var(--bad)" }}>
        <div className="row between">
          <strong style={{ color: "var(--bad)" }}>Draft failed</strong>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>close</button>
        </div>
        <div className="sm" style={{ marginTop: 8 }}>{draft.error || "Unknown error"}</div>
      </div>
    );
  }
  const id = draft.id;
  const matched = draft.matched_questions || [];
  return (
    <div className="card" style={{ borderColor: "var(--accent)" }}>
      <div className="row between">
        <strong>📝 Draft ready — review and submit</strong>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>close</button>
      </div>
      <p className="sm muted" style={{ marginTop: 4 }}>
        Application #{id} · {matched.length} question{matched.length === 1 ? "" : "s"} answered.
        Edit the cover letter on the application page if needed.
      </p>
      <div className="sm" style={{ marginTop: 12, padding: 12, background: "var(--bg-elev)", borderRadius: 8, maxHeight: 300, overflow: "auto", whiteSpace: "pre-wrap" }}>
        {draft.cover_letter}
      </div>
      {matched.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary className="sm">Custom answers ({matched.length})</summary>
          <div className="sm" style={{ marginTop: 8 }}>
            {matched.map((m: any, i: number) => (
              <div key={i} style={{ marginBottom: 8 }}>
                <div className="xs muted">Q: {m.q}</div>
                <div style={{ padding: 6, background: "var(--bg-elev)", borderRadius: 4 }}>{m.a}</div>
              </div>
            ))}
          </div>
        </details>
      )}
      <div className="row wrap" style={{ marginTop: 12, gap: 8 }}>
        <button className="btn btn-primary" onClick={() => onSubmit(id)} data-testid="submit-draft-btn">
          📤 Submit & email me
        </button>
        <a href={`/applications/${id}`} className="btn btn-ghost" style={{ textDecoration: "none" }}>
          Edit cover letter →
        </a>
      </div>
    </div>
  );
}

function AutoSubmitViewer({ run, onClose }: { run: any; onClose: () => void }) {
  // Assisted (no Browser Rendering): show the prepared form answers
  // and a "Open the job URL + paste these answers" workflow.
  if (run?.mode === "assisted") {
    const llm = run.llm_answers || [];
    const fields = run.form_filled || {};
    return (
      <div className="card" style={{ borderColor: "var(--accent)" }}>
        <div className="row between">
          <strong>🤖 Assisted apply — form answers drafted</strong>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>close</button>
        </div>
        <p className="sm muted" style={{ marginTop: 4 }}>
          Browser Rendering isn't enabled on this Cloudflare account, so we fetched the job HTML and drafted answers for you. Open the link below, paste the values into the form, then come back and tap <em>Submit & email</em> on the row.
        </p>
        <p className="sm" style={{ marginTop: 8 }}>
          <strong>Job URL: </strong>
          <a href={run.job_url} target="_blank" rel="noreferrer">{run.job_url}</a>
        </p>
        <p className="xs muted" style={{ marginTop: 4 }}>
          Detected {run.fields_detected} form fields · Filled {run.fields_filled} values
        </p>

        <details style={{ marginTop: 12 }} open>
          <summary className="sm"><strong>Pre-filled values (paste these into the form)</strong></summary>
          <table style={{ marginTop: 8 }}>
            <thead><tr><th>Field</th><th>Value</th><th>Source</th></tr></thead>
            <tbody>
              {Object.entries(fields).map(([k, v]: any) => (
                <tr key={k}>
                  <td><code className="mono xs">{k}</code></td>
                  <td className="sm" style={{ wordBreak: "break-word", maxWidth: 360 }}>{String(v.value ?? "—").slice(0, 600)}</td>
                  <td className="sm dim">{v.source ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>

        {llm.length > 0 ? (
          <details style={{ marginTop: 8 }} open>
            <summary className="sm"><strong>LLM-drafted answers ({llm.length})</strong></summary>
            <div style={{ marginTop: 8 }} className="col" data-gap="12">
              {llm.map((a: any, i: number) => (
                <div key={i} className="card card-tight" style={{ padding: 10 }}>
                  <div className="xs dim mono">{a.field || a.label || `Answer ${i + 1}`}</div>
                  <div className="sm" style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>{a.answer}</div>
                </div>
              ))}
            </div>
          </details>
        ) : null}

        <details style={{ marginTop: 8 }}>
          <summary className="sm">Log ({run.log?.length || 0} steps)</summary>
          <pre className="mono xs" style={{ marginTop: 8, padding: 8, background: "var(--bg-elev)", borderRadius: 4, maxHeight: 200, overflow: "auto" }}>
            {(run.log || []).map((l: any) => JSON.stringify(l)).join("\n")}
          </pre>
        </details>
      </div>
    );
  }

  // Headless path (Browser Rendering available)
  return (
    <div className="card" style={{ borderColor: run.confirmed_by_page ? "var(--good)" : "var(--warn)" }}>
      <div className="row between">
        <strong>{run.confirmed_by_page ? "✅ Auto-submit completed" : "⚠️ Auto-submit sent (confirmation page not detected)"}</strong>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>close</button>
      </div>
      <p className="sm muted" style={{ marginTop: 4 }}>
        Final URL: <a href={run.final_url} target="_blank" rel="noreferrer">{run.final_url}</a>
      </p>
      {run.screenshot_base64 && (
        <div style={{ marginTop: 8 }}>
          <div className="xs dim" style={{ marginBottom: 4 }}>Post-submit page screenshot:</div>
          <img src={run.screenshot_base64} alt="post-submit" style={{ maxWidth: "100%", border: "1px solid var(--border)", borderRadius: 8 }} />
        </div>
      )}
      <details style={{ marginTop: 8 }} open>
        <summary className="sm">Form fields filled ({Object.keys(run.form_filled || {}).length})</summary>
        <table style={{ marginTop: 8 }}>
          <thead><tr><th>Field</th><th>Value</th><th>Source</th></tr></thead>
          <tbody>
            {Object.entries(run.form_filled || {}).map(([k, v]: any) => (
              <tr key={k}>
                <td><code className="mono xs">{k}</code></td>
                <td className="sm">{String(v.value ?? v.action ?? "—").slice(0, 200)}</td>
                <td className="sm dim">{v.source ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      <details style={{ marginTop: 8 }}>
        <summary className="sm">Log ({run.log?.length || 0} steps)</summary>
        <pre className="mono xs" style={{ marginTop: 8, padding: 8, background: "var(--bg-elev)", borderRadius: 4, maxHeight: 200, overflow: "auto" }}>
          {(run.log || []).map((l: any, i: number) => JSON.stringify(l)).join("\n")}
        </pre>
      </details>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: any }) {
  return (
    <div className="card card-tight" style={{ padding: 10 }}>
      <div className="xs muted" style={{ textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 600 }}>{label}</div>
      <div className="mono" style={{ fontSize: 18, fontWeight: 700 }}>{value}</div>
    </div>
  );
}
