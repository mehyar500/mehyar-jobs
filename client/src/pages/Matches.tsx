import { useEffect, useState } from "react";
import { Link } from "wouter";
import { api } from "../lib/api";
import ReferralCard from "../components/ReferralCard";
import { useToast } from "../lib/toast";

export default function Matches() {
  const toast = useToast();
  const [me, setMe] = useState<any>(null);
  const [matches, setMatches] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [minScore, setMinScore] = useState(50);
  const [newsletter, setNewsletter] = useState<boolean | null>(null);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [sponsor, setSponsor] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  async function load(p = 0, ms = minScore) {
    setLoading(true);
    try {
      const [m, mm, al] = await Promise.all([api.me(), api.myMatches({ page: p, limit: 30, min_score: ms }), api.myAlerts().catch(() => ({ alerts: [] }))]);
      const spP: Promise<any> = api.sponsored("matches").catch(() => ({ sponsor: null }));
      const sp = await spP;
      setMe(m); setMatches(mm.matches || []); setTotal(mm.total || 0); setPage(p);
      setAlerts(al.alerts || []);
      setSponsor(sp.sponsor || null);
      if (newsletter === null) setNewsletter(!!m.newsletter_opt_in);
    } catch { setMatches([]); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (api.isUserSession()) load(0); else setLoading(false); }, []);

  async function toggleNl(v: boolean) {
    await api.setNewsletter(v);
    setNewsletter(v);
  }

  async function removeAlert(id: number) {
    try {
      await api.deleteAlert(id);
      setAlerts((a) => a.filter((x) => x.id !== id));
      toast.push({ kind: "success", title: "Alert removed", message: "You won't get emails for that search anymore." });
    } catch (e: any) {
      toast.push({ kind: "error", title: "Couldn't remove alert", message: e?.body?.message || e?.message });
    }
  }

  if (loading) return <div className="card">Loading…</div>;
  if (!api.isUserSession()) {
    return (
      <div className="card" style={{ textAlign: "center", padding: 40, maxWidth: 520, margin: "0 auto" }}>
        <h1 className="h1">⭐ Your matches</h1>
        <p className="sm muted" style={{ marginTop: 8 }}>Log in or create a free account to see jobs matched to your resume.</p>
        <div className="row" style={{ gap: 8, justifyContent: "center", marginTop: 16 }}>
          <Link href="/signup"><button className="btn btn-primary">Create free account</button></Link>
          <Link href="/login"><button className="btn">Log in</button></Link>
        </div>
      </div>
    );
  }

  return (
    <div className="col" style={{ gap: 16, maxWidth: 820, margin: "0 auto", paddingBottom: 48 }}>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <div>
            <h1 className="h1">⭐ Matches for {me?.display_name || me?.email}</h1>
            <p className="sm muted" style={{ marginTop: 4 }}>
              {total ? `${total} jobs match your resume (scored ≥ ${minScore})` : "No matches yet — run your resume to score every job."}
            </p>
          </div>
          <Link href="/run"><button className="btn btn-primary">↻ Re-run resume</button></Link>
        </div>
      </div>

      <div className="card card-tight row" style={{ justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <span className="sm">Min score</span>
          {[35, 50, 70].map((s) => (
            <button key={s} className={"btn" + (minScore === s ? " btn-primary" : "")} onClick={() => { setMinScore(s); load(0, s); }}>{s}+</button>
          ))}
        </div>
        <label className="row sm" style={{ gap: 8, alignItems: "center", cursor: "pointer" }}>
          <input type="checkbox" checked={!!newsletter} onChange={(e) => toggleNl(e.target.checked)} />
          📬 Daily email matches
        </label>
      </div>

      {sponsor && (
        <div className="card card-tight" style={{ border: "1px dashed var(--warn)", background: "color-mix(in srgb, var(--warn) 6%, transparent)" }}>
          <div className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <div>
              <span className="xs" style={{ fontWeight: 800, letterSpacing: ".08em", color: "var(--warn)" }}>SPONSORED</span>
              <div style={{ fontWeight: 700, marginTop: 4 }}>{sponsor.headline}</div>
              {sponsor.body && <div className="sm muted" style={{ marginTop: 2 }}>{sponsor.body}</div>}
              {sponsor.job && <div className="sm muted" style={{ marginTop: 4 }}>📌 {sponsor.job.title} — {sponsor.job.company_name}{sponsor.job.location ? ` · ${sponsor.job.location}` : ""}</div>}
              <div className="xs muted" style={{ marginTop: 4 }}>Paid placement by {sponsor.name}</div>
            </div>
            <a href={sponsor.job?.url || sponsor.cta_url} target="_blank" rel="noreferrer"><button className="btn btn-primary btn-sm">{sponsor.cta_text || "Learn more"} →</button></a>
          </div>
        </div>
      )}

      {/* Remote seekers: exactly one offer — FlexJobs. Distinct touchpoint from the sponsored slot above. */}
      {matches.some((m) => m.remote_policy === "remote") && (
        <div className="card card-tight" style={{ border: "1px solid var(--warn)" }}>
          <div className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <div>
              <span className="xs" style={{ fontWeight: 800, letterSpacing: ".08em", color: "var(--warn)" }}>SPONSORED · PARTNER PICK</span>
              <div style={{ fontWeight: 700, marginTop: 4 }}>Want more remote options? These are hand-screened.</div>
              <div className="sm muted" style={{ marginTop: 2 }}>FlexJobs vets every listing — 30,000+ remote jobs with the scams already removed.</div>
            </div>
            <a href="/go/flexjobs"><button className="btn btn-primary btn-sm">Browse remote jobs →</button></a>
          </div>
        </div>
      )}

      <div className="col" style={{ gap: 8 }}>
        {matches.map((m) => (
          <div key={m.job_id} className="card card-tight">
            <div className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontWeight: 700 }}>{m.title} <span className="pill" style={{ marginLeft: 6 }}>{m.score}/100</span>{m.featured ? <span className="pill" style={{ marginLeft: 6, background: "rgba(245,158,11,.15)", color: "var(--warn)" }}>⭐ Featured</span> : null}</div>
                <div className="sm muted">{m.company}{m.location ? ` · ${m.location}` : ""}{m.remote_policy === "remote" ? " · 🌐 remote" : ""}</div>
              </div>
              {m.url && <a href={m.url} target="_blank" rel="noreferrer"><button className="btn btn-ghost">Apply →</button></a>}
            </div>
            {Array.isArray(m.reasons) && m.reasons.length > 0 && (
              <details className="sm" style={{ marginTop: 6 }}>
                <summary style={{ cursor: "pointer", color: "var(--accent)", fontWeight: 600 }}>🔍 Why this fit?</summary>
                <ul className="muted" style={{ margin: "6px 0 0", paddingLeft: 18, lineHeight: 1.5 }}>
                  {m.reasons.map((r: string, i: number) => <li key={i}>{r}</li>)}
                </ul>
              </details>
            )}
          </div>
        ))}
        {!matches.length && !loading && (
          <div className="card card-tight muted">Nothing at this score yet. Try lowering the minimum score or re-run your resume.</div>
        )}
      </div>

      {/* ── Job alerts ── */}
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <div>
            <h2 className="h2">🔔 Job alerts</h2>
            <p className="sm muted" style={{ marginTop: 4 }}>
              We email you only when <em>new</em> jobs match a saved search. Create one from the job browser with the “🔔 Alert me” button.
            </p>
          </div>
          <Link href="/"><button className="btn btn-ghost btn-sm">Browse jobs →</button></Link>
        </div>
        {alerts.length === 0 ? (
          <p className="sm muted" style={{ marginTop: 12 }}>No alerts yet. Save a search and we'll watch the board for you.</p>
        ) : (
          <div className="col" style={{ gap: 8, marginTop: 12 }}>
            {alerts.map((a) => (
              <div key={a.id} className="row card-tight" style={{ justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px" }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{a.name}</div>
                  <div className="xs muted">
                    {a.last_sent_at ? `Last checked ${a.last_sent_at.slice(0, 16).replace("T", " ")}` : "Watching from now"}
                    {a.last_match_count ? ` · ${a.last_match_count} sent last time` : ""}
                  </div>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={() => removeAlert(a.id)}>Turn off</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <ReferralCard />

      {total > 30 && (
        <div className="row" style={{ gap: 8, justifyContent: "center" }}>
          <button className="btn" disabled={page === 0} onClick={() => load(page - 1)}>← Prev</button>
          <span className="sm muted" style={{ alignSelf: "center" }}>Page {page + 1} of {Math.ceil(total / 30)}</span>
          <button className="btn" disabled={(page + 1) * 30 >= total} onClick={() => load(page + 1)}>Next →</button>
        </div>
      )}
    </div>
  );
}
