import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { api } from "../lib/api";
import { useToast } from "../lib/toast";

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

export function ApplicationsList() {
  const qc = useQueryClient();
  const toast = useToast();
  const [statusFilter, setStatusFilter] = useState<string>("");
  const appsQ = useQuery({
    queryKey: ["applications", statusFilter],
    queryFn: () => api.applications(statusFilter || undefined),
    refetchInterval: 30_000,
  });

  const onBulkAutoApply = async () => {
    if (!confirm("🤖 BULK AUTO-APPLY (headless browser):\n\nThis will run the headless browser against all your draft applications with fit score ≥ 70 in parallel (max 25 at a time).\n\n⚠️  Most ATS systems (Greenhouse, Lever, Ashby, Workday) prohibit this in their ToS — your account can be banned.\n\nContinue?")) return;
    setBulkRunning(true);
    try {
      const r: any = await api.bulkAutoApply({ confirm: true });
      const succeeded = r.succeeded || 0, failed = r.failed || 0;
      toast.push({
        kind: r.failed === 0 ? "success" : "info",
        title: `🤖 Bulk complete: ${succeeded}/${r.ran} succeeded`,
        message: failed > 0 ? `${failed} failed. Check the Applications tab for details.` : "All draft applications auto-submitted.",
        duration: 8000,
      });
      qc.invalidateQueries({ queryKey: ["applications"] });
      qc.invalidateQueries({ queryKey: ["jobs"] });
    } catch (e: any) {
      toast.push({ kind: "error", title: "Bulk auto-apply failed", message: e?.body?.error || e?.message });
    } finally {
      setBulkRunning(false);
    }
  };

  const [bulkRunning, setBulkRunning] = useState(false);

  const onExport = async () => {
    try {
      const blob = await api.exportApplicationsCSV();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `mehyar-jobs-applications-${new Date().toISOString().slice(0,10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.push({ kind: "success", title: "CSV downloaded", message: "Saved to your Downloads folder." });
    } catch (e: any) {
      toast.push({ kind: "error", title: "Export failed", message: e?.message });
    }
  };

  const items: any[] = appsQ.data?.items || [];
  const counts = useMemo(() => {
    const all = appsQ.data?.items || [];
    return {
      all:         all.length,
      draft:       all.filter((a: any) => a.status === "draft").length,
      submitted:   all.filter((a: any) => a.status === "submitted").length,
      confirmed:   all.filter((a: any) => !!a.company_confirmed_at).length,
      unconfirmed: all.filter((a: any) => a.status === "submitted" && !a.company_confirmed_at).length,
      no_reply_3d: all.filter((a: any) => a.status === "submitted" && !a.company_confirmed_at && a.submitted_at && (Date.now() - Date.parse(a.submitted_at) > 3*86400000)).length,
      failed:      all.filter((a: any) => a.status === "failed").length,
      withdrawn:   all.filter((a: any) => a.status === "withdrawn").length,
    };
  }, [appsQ.data]);

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card">
        <div className="between wrap" style={{ gap: 12 }}>
          <div>
            <h1 className="h1">📤 My applications</h1>
            <p className="sm muted" style={{ marginTop: 4 }}>
              Drafts are pre-filled with cover letter + answers matched to the job. Click "Submit & email me" to log + send the confirmation.
            </p>
          </div>
        </div>
        <div className="row wrap" style={{ marginTop: 12, gap: 6 }}>
          {[
            ["",            "all",                    counts.all],
            ["draft",       "📝 drafts",              counts.draft],
            ["submitted",   "📤 submitted",           counts.submitted],
            ["confirmed",   "✅ company confirmed",   counts.confirmed],
            ["unconfirmed", "⏳ no reply yet",        counts.unconfirmed],
            ["no_reply_3d", "🕓 3+ days no reply",    counts.no_reply_3d],
            ["failed",      "❌ failed",               counts.failed],
            ["withdrawn",   "🚫 withdrawn",           counts.withdrawn],
          ].map(([k, label, n]: any) => (
            <button key={k} className={`tab ${statusFilter === k ? "active" : ""}`} onClick={() => setStatusFilter(k)}>
              {label} ({n})
            </button>
          ))}
          <span className="grow" />
          <button
            className="btn btn-sm btn-primary"
            onClick={onBulkAutoApply}
            disabled={bulkRunning}
            title="Run the headless browser against all draft applications with fit score above 70 in parallel. ⚠️ May violate ATS ToS."
          >
            {bulkRunning ? <><span className="spinner" /> bulk running…</> : "🤖 Bulk auto-apply drafts"}
          </button>
          <button className="btn btn-sm" onClick={onExport} title="Download a CSV of every application">
            ⬇️ Export CSV
          </button>
        </div>
      </div>

      <div className="card card-tight" style={{ padding: 0 }}>
        {appsQ.isLoading ? (
          <div className="col" style={{ padding: 16, gap: 8 }}>
            {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skel" />)}
          </div>
        ) : items.length === 0 ? (
          <div className="col" style={{ padding: 32, textAlign: "center", gap: 8 }}>
            <span style={{ fontSize: 36 }}>📭</span>
            <h2 className="h2">No applications yet</h2>
            <p className="sm muted">Click <strong>Apply</strong> on any job in the Jobs tab to create a draft.</p>
            <a href="/" className="btn btn-primary" style={{ textDecoration: "none", marginTop: 8 }}>Browse jobs →</a>
          </div>
        ) : (
          <table className="responsive-table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Company</th>
                <th>Status</th>
                <th>Submitted</th>
                <th>Company reply</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a: any) => {
                const daysSince = a.submitted_at ? Math.floor((Date.now() - Date.parse(a.submitted_at)) / 86400000) : null;
                return (
                  <tr key={a.id}>
                    <td data-label="Job">
                      <a href={`/applications/${a.id}`} style={{ color: "inherit", textDecoration: "none" }}>
                        <div className="h3">{a.job_title}</div>
                        <div className="xs dim">{a.job_location || "—"}{a.job_remote_policy && a.job_remote_policy !== "unknown" ? " · " + a.job_remote_policy : ""}</div>
                      </a>
                    </td>
                    <td data-label="Company">
                      <a href={`/companies?q=${encodeURIComponent(a.company_name)}`} style={{ color: "inherit", textDecoration: "none" }}>{a.company_name}</a>
                    </td>
                    <td data-label="Status"><StatusTag status={a.status} confirmedAt={a.company_confirmed_at} daysSince={daysSince} /></td>
                    <td data-label="Submitted" className="sm dim">
                      {a.submitted_at ? relativeTime(a.submitted_at) : <span className="dim">—</span>}
                      {daysSince != null && daysSince >= 3 && !a.company_confirmed_at ? <div className="xs" style={{ color: "var(--warn)" }}>⚠ {daysSince}d no reply</div> : null}
                    </td>
                    <td data-label="Company reply" className="sm">
                      {a.company_confirmed_at ? (
                        <div>
                          <div className="status-pill submitted">✅ confirmed</div>
                          <div className="xs dim" style={{ marginTop: 2 }}>{relativeTime(a.company_confirmed_at)}</div>
                          {a.company_email_subject ? <div className="xs dim" style={{ marginTop: 2, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={a.company_email_subject}>"{a.company_email_subject}"</div> : null}
                        </div>
                      ) : a.status === "submitted" ? (
                        <a href={`/applications/${a.id}`} className="status-pill draft" style={{ textDecoration: "none" }}>⏳ waiting</a>
                      ) : (
                        <span className="dim">—</span>
                      )}
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

export function ApplicationDetail() {
  const params = useParams<{ id: string }>();
  const [, setLoc] = useLocation();
  const qc = useQueryClient();
  const toast = useToast();
  const id = parseInt(params.id, 10);
  const [editing, setEditing] = useState(false);
  const [cover, setCover] = useState("");
  const [notes, setNotes] = useState("");
  const [answerEdits, setAnswerEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [confirmSubject, setConfirmSubject] = useState("");

  const appQ = useQuery({
    queryKey: ["application", id],
    queryFn: () => api.getApplication(id),
    enabled: !isNaN(id),
  });

  const app = appQ.data?.application;
  const events: any[] = appQ.data?.events || [];

  // Initialize edit form when data first loads
  if (app && !editing && cover === "" && app.cover_letter) {
    setCover(app.cover_letter);
    setNotes(app.notes || "");
    setAnswerEdits(app.custom_answers || {});
  }

  if (appQ.isLoading) return <div className="card">Loading…</div>;
  if (!app) return <div className="card">Application not found.</div>;

  const save = async () => {
    setBusy(true);
    try {
      await api.updateApplication(id, { cover_letter: cover, notes, custom_answers: answerEdits });
      qc.invalidateQueries({ queryKey: ["application", id] });
      qc.invalidateQueries({ queryKey: ["applications"] });
      setEditing(false);
    } catch (e: any) {
      alert("save failed: " + (e?.body?.error || e?.message));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!confirm("Submit this application? You'll get a confirmation email.")) return;
    setBusy(true);
    try {
      const r = await api.submitApplication(id);
      qc.invalidateQueries({ queryKey: ["application", id] });
      qc.invalidateQueries({ queryKey: ["applications"] });
      if (r.email?.sent) {
        alert("Submitted! Check your email for the confirmation.");
      } else if (r.email?.error) {
        alert("Submitted, but email failed: " + r.email.error + "\n(Application is recorded in the system.)");
      }
    } catch (e: any) {
      alert("submit failed: " + (e?.body?.error || e?.message));
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async () => {
    if (!confirm("Withdraw this application? This is a soft delete — you can still see it under 'withdrawn'.")) return;
    await api.withdrawApplication(id);
    qc.invalidateQueries({ queryKey: ["application", id] });
    qc.invalidateQueries({ queryKey: ["applications"] });
  };

  const markCompanyConfirmed = async () => {
    setBusy(true);
    try {
      await api.confirmApplication(id, confirmSubject || undefined);
      qc.invalidateQueries({ queryKey: ["application", id] });
      qc.invalidateQueries({ queryKey: ["applications"] });
      setConfirmSubject("");
      toast.push({ kind: "success", title: "✅ Company reply recorded", message: "Marked as confirmed. This row will now show in the 'company confirmed' filter." });
    } catch (e: any) {
      toast.push({ kind: "error", title: "Failed to record confirmation", message: e?.body?.error || e?.message });
    } finally {
      setBusy(false);
    }
  };

  const unconfirm = async () => {
    if (!confirm("Undo the company confirmation? This will set it back to 'awaiting reply'.")) return;
    await api.unconfirmApplication(id);
    qc.invalidateQueries({ queryKey: ["application", id] });
    qc.invalidateQueries({ queryKey: ["applications"] });
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card">
        <div className="between wrap" style={{ gap: 12 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <a href={`${app.job_url}`} target="_blank" rel="noreferrer" className="h1" style={{ color: "inherit", textDecoration: "none" }}>
              {app.job_title}
            </a>
            <div className="sm muted" style={{ marginTop: 4 }}>
              at <strong>{app.company_name}</strong> · {app.job_location || "—"}{app.job_remote_policy && app.job_remote_policy !== "unknown" ? " · " + app.job_remote_policy : ""} · Fit {app.job_score ?? "—"}
            </div>
            <div className="sm muted" style={{ marginTop: 4 }}>
              <StatusTag status={app.status} confirmedAt={app.company_confirmed_at} daysSince={app.submitted_at ? Math.floor((Date.now() - Date.parse(app.submitted_at))/86400000) : null} />
              {app.submitted_at ? <> · submitted {relativeTime(app.submitted_at)}</> : null}
              {app.company_confirmed_at ? <> · ✅ company confirmed {relativeTime(app.company_confirmed_at)}</> : null}
            </div>
            {app.tracking_email && (
              <div className="row" style={{ gap: 6, marginTop: 6, alignItems: "center" }}>
                <span className="xs dim">tracking email:</span>
                <code className="mono xs" style={{ padding: "2px 6px", background: "var(--bg-elev)", borderRadius: 4, border: "1px solid var(--border)" }}>{app.tracking_email}</code>
                <button className="btn btn-ghost btn-sm" onClick={() => navigator.clipboard.writeText(app.tracking_email)}>Copy</button>
                <span className="xs dim">— use this as the contact email on the company form for auto-confirm</span>
              </div>
            )}
          </div>
          <div className="row wrap" style={{ gap: 6 }}>
            {app.status === "draft" && (
              <button className="btn btn-primary" onClick={submit} disabled={busy} data-testid="submit-detail-btn">
                📤 Submit & email me
              </button>
            )}
            {!editing && app.status !== "withdrawn" && (
              <button className="btn btn-ghost" onClick={() => setEditing(true)}>Edit</button>
            )}
            {app.status !== "withdrawn" && (
              <button className="btn btn-ghost" onClick={withdraw} disabled={busy}>Withdraw</button>
            )}
          </div>
        </div>
      </div>

      {/* Company confirmation — the user clicks this when the 3rd-party email arrives */}
      {(app.status === "submitted" || app.status === "failed") && (
        <div className="card" style={{ borderColor: app.company_confirmed_at ? "var(--good)" : "var(--border)" }}>
          <h2 className="h2">📨 Did the company confirm?</h2>
          {app.company_confirmed_at ? (
            <>
              <div className="row" style={{ marginTop: 8, gap: 8, flexWrap: "wrap" }}>
                <span className="status-pill submitted">✅ confirmed {relativeTime(app.company_confirmed_at)}</span>
                <span className="tag tag-zinc xs">{app.company_confirmed_source === "auto_email" ? "auto-detected" : "manually marked"}</span>
              </div>
              {app.company_email_subject ? <div className="sm muted" style={{ marginTop: 8 }}>Subject: "{app.company_email_subject}"</div> : null}
              {(() => {
                const days = app.submitted_at ? Math.floor((Date.parse(app.company_confirmed_at) - Date.parse(app.submitted_at)) / 86400000) : null;
                return days != null ? <div className="xs dim" style={{ marginTop: 4 }}>Replied {days} day{days === 1 ? "" : "s"} after you submitted</div> : null;
              })()}
              <button className="btn btn-ghost btn-sm" style={{ marginTop: 12 }} onClick={unconfirm} disabled={busy}>Undo confirmation</button>
            </>
          ) : (
            <>
              <p className="sm muted" style={{ marginTop: 4 }}>
                Once you see the "thank you for applying" email in your inbox, click below to mark this row as confirmed.
                We track what you submitted; the company is the source of truth for replies.
              </p>
              <div className="row wrap" style={{ marginTop: 10, gap: 8 }}>
                <input
                  type="text"
                  placeholder="Subject line (optional) — e.g. 'Thank you for applying to OpenAI'"
                  value={confirmSubject}
                  onChange={(e) => setConfirmSubject(e.target.value)}
                  style={{ flex: 1, minWidth: 220 }}
                />
                <button className="btn btn-primary" onClick={markCompanyConfirmed} disabled={busy} data-testid="mark-confirmed-btn">
                  ✅ I got the company's email
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Cover letter */}
      <div className="card">
        <h2 className="h2">📝 Cover letter</h2>
        {editing ? (
          <textarea value={cover} onChange={(e) => setCover(e.target.value)} style={{ width: "100%", minHeight: 240, fontFamily: "ui-monospace, monospace", fontSize: 13, padding: 10 }} />
        ) : (
          <div className="sm" style={{ marginTop: 8, padding: 12, background: "var(--bg-elev)", borderRadius: 8, whiteSpace: "pre-wrap" }}>{app.cover_letter || <span className="dim">No cover letter yet.</span>}</div>
        )}
      </div>

      {/* Custom answers */}
      {Object.keys(app.custom_answers || {}).length > 0 && (
        <div className="card">
          <h2 className="h2">💬 Custom answers</h2>
          <div className="col" style={{ gap: 12, marginTop: 8 }}>
            {Object.entries(app.custom_answers as Record<string, string>).map(([q, a], i) => (
              <div key={i}>
                <div className="xs muted" style={{ marginBottom: 4 }}>{q}</div>
                {editing ? (
                  <textarea value={answerEdits[q] ?? a} onChange={(e) => setAnswerEdits({ ...answerEdits, [q]: e.target.value })} style={{ width: "100%", minHeight: 60, fontFamily: "ui-monospace, monospace", fontSize: 13, padding: 8 }} />
                ) : (
                  <div className="sm" style={{ padding: 8, background: "var(--bg-elev)", borderRadius: 6 }}>{a}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Notes */}
      <div className="card">
        <h2 className="h2">📌 Notes (private)</h2>
        {editing ? (
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Internal notes, not sent to employer" style={{ width: "100%", minHeight: 80, fontSize: 13, padding: 10 }} />
        ) : (
          <div className="sm dim" style={{ marginTop: 8 }}>{app.notes || "—"}</div>
        )}
      </div>

      {/* Audit trail */}
      {events.length > 0 && (
        <div className="card">
          <h2 className="h2">🕓 Activity</h2>
          <div className="col" style={{ gap: 6, marginTop: 8 }}>
            {events.map((e: any) => (
              <div key={e.id} className="row sm" style={{ gap: 8 }}>
                <span className="tag tag-zinc xs">{e.kind}</span>
                <span className="dim">{e.detail || ""}</span>
                <span className="dim xs">{relativeTime(e.created_at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {editing && (
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-primary" onClick={save} disabled={busy}>Save changes</button>
          <button className="btn btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}

function StatusTag({ status, confirmedAt, daysSince }: { status: string; confirmedAt?: string | null; daysSince?: number | null }) {
  if (status === "submitted" && confirmedAt) {
    return <span className="status-pill submitted" title={`confirmed ${daysSince}d after submit`}>✅ confirmed</span>;
  }
  if (status === "submitted" && daysSince != null && daysSince >= 3) {
    return <span className="status-pill draft" title={`${daysSince} days since submitted, no reply`}>⏳ {daysSince}d no reply</span>;
  }
  if (status === "submitted") {
    return <span className="status-pill submitting" title="awaiting company reply">⏳ awaiting reply</span>;
  }
  const cls = {
    draft: "status-pill draft",
    failed: "status-pill failed",
    withdrawn: "status-pill withdrawn",
    submitting: "status-pill submitting",
  }[status] || "status-pill withdrawn";
  const label = { draft: "📝 draft", failed: "❌ failed", withdrawn: "🚫 withdrawn", submitting: "… submitting" }[status] || status;
  return <span className={cls}>{label}</span>;
}
