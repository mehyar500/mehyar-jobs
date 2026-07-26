import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { api } from "../lib/api";

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
  const [statusFilter, setStatusFilter] = useState<string>("");
  const appsQ = useQuery({
    queryKey: ["applications", statusFilter],
    queryFn: () => api.applications(statusFilter || undefined),
    refetchInterval: 30_000,
  });

  const items: any[] = appsQ.data?.items || [];
  const counts = useMemo(() => {
    const all = appsQ.data?.items || [];
    return {
      all:        all.length,
      draft:      all.filter((a: any) => a.status === "draft").length,
      submitted:  all.filter((a: any) => a.status === "submitted").length,
      failed:     all.filter((a: any) => a.status === "failed").length,
      withdrawn:  all.filter((a: any) => a.status === "withdrawn").length,
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
            ["", "all", counts.all],
            ["draft", "drafts", counts.draft],
            ["submitted", "submitted", counts.submitted],
            ["failed", "failed", counts.failed],
            ["withdrawn", "withdrawn", counts.withdrawn],
          ].map(([k, label, n]: any) => (
            <button key={k} className={`tab ${statusFilter === k ? "active" : ""}`} onClick={() => setStatusFilter(k)}>
              {label} ({n})
            </button>
          ))}
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
          <table>
            <thead>
              <tr>
                <th>Job</th>
                <th>Company</th>
                <th>Status</th>
                <th>Updated</th>
                <th>Submitted</th>
                <th>Email</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a: any) => (
                <tr key={a.id}>
                  <td>
                    <a href={`/applications/${a.id}`} style={{ color: "inherit", textDecoration: "none" }}>
                      <div className="h3">{a.job_title}</div>
                      <div className="xs dim">{a.job_location || "—"}{a.job_remote_policy && a.job_remote_policy !== "unknown" ? " · " + a.job_remote_policy : ""}</div>
                    </a>
                  </td>
                  <td>
                    <a href={`/companies?q=${encodeURIComponent(a.company_name)}`} style={{ color: "inherit", textDecoration: "none" }}>{a.company_name}</a>
                  </td>
                  <td><StatusTag status={a.status} /></td>
                  <td className="sm dim">{relativeTime(a.updated_at)}</td>
                  <td className="sm dim">{a.submitted_at ? relativeTime(a.submitted_at) : "—"}</td>
                  <td className="sm dim">{a.email_sent_at ? "✓ " + relativeTime(a.email_sent_at) : (a.email_id ? "✓" : (a.status === "submitted" ? "—" : ""))}</td>
                </tr>
              ))}
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
  const id = parseInt(params.id, 10);
  const [editing, setEditing] = useState(false);
  const [cover, setCover] = useState("");
  const [notes, setNotes] = useState("");
  const [answerEdits, setAnswerEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

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

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card">
        <div className="between wrap" style={{ gap: 12 }}>
          <div>
            <a href={`${app.job_url}`} target="_blank" rel="noreferrer" className="h1" style={{ color: "inherit", textDecoration: "none" }}>
              {app.job_title}
            </a>
            <div className="sm muted" style={{ marginTop: 4 }}>
              at <strong>{app.company_name}</strong> · {app.job_location || "—"}{app.job_remote_policy && app.job_remote_policy !== "unknown" ? " · " + app.job_remote_policy : ""} · Fit {app.job_score ?? "—"}
            </div>
            <div className="sm muted" style={{ marginTop: 4 }}>
              <StatusTag status={app.status} />
              {app.submitted_at ? <> · submitted {relativeTime(app.submitted_at)}</> : null}
              {app.email_sent_at ? <> · ✓ email sent {relativeTime(app.email_sent_at)}</> : null}
            </div>
          </div>
          <div className="row" style={{ gap: 6 }}>
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

function StatusTag({ status }: { status: string }) {
  const cls = {
    draft: "tag-amber", submitted: "tag-emerald", failed: "tag-red",
    withdrawn: "tag-zinc", submitting: "tag-sky",
  }[status] || "tag-zinc";
  return <span className={`tag ${cls} xs`}>{status}</span>;
}
