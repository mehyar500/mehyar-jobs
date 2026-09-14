import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { api } from "../lib/api";
import { useToast } from "../lib/toast";

function SubscribeBox() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");

  async function submit(e: any) {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) {
      setState("error"); setMsg("That email doesn't look right — try again.");
      return;
    }
    setState("busy"); setMsg("");
    try {
      const r: any = await api.subscribeNewsletter(email.trim());
      setState("done");
      setMsg(r?.already ? "You're already on the list — watch your inbox." : "Check your inbox to confirm — one tap and you're in.");
    } catch {
      setState("error"); setMsg("Something went wrong. Try again in a moment.");
    }
  }

  if (state === "done") {
    return <p className="sm" style={{ color: "var(--good)", fontWeight: 700, margin: 0 }}>✅ {msg}</p>;
  }
  return (
    <form onSubmit={submit} className="row" style={{ gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
      <input
        type="email" value={email} onChange={(e) => setEmail(e.target.value)}
        placeholder="you@email.com" aria-label="Email address"
        style={{ borderRadius: 10, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--fg)", padding: "10px 14px", fontSize: 15, minWidth: 240 }}
      />
      <button type="submit" className="btn btn-primary" disabled={state === "busy"}>
        {state === "busy" ? "Subscribing…" : "Subscribe free"}
      </button>
      {state === "error" && <p className="sm" style={{ color: "var(--bad)", width: "100%", margin: "4px 0 0" }}>{msg}</p>}
      <p className="xs muted" style={{ width: "100%", margin: "4px 0 0" }}>
        Double opt-in — we confirm it's really you. <Link href="/unsubscribe">Unsubscribe</Link> anytime.
      </p>
    </form>
  );
}

function fmtSalary(j: any) {
  if (j.salary_min || j.salary_max) {
    const lo = j.salary_min ? `$${Number(j.salary_min).toLocaleString()}` : "";
    const hi = j.salary_max ? `$${Number(j.salary_max).toLocaleString()}` : "";
    const cur = j.salary_currency ? ` ${j.salary_currency}` : "";
    // A "range" with min == max is a data artifact — show a single figure.
    if (lo && hi && lo === hi) return `${lo}${cur}`;
    return `${lo}${lo && hi ? " – " : ""}${hi}${cur}`;
  }
  return "";
}

// Source titles sometimes carry typos ("Upto") — clean the visible ones.
function cleanTitle(t: any) {
  return String(t || "").replace(/\bUpto\b/g, "Up to").replace(/\b upto\b/g, " up to");
}

export default function Landing() {
  const toast = useToast();
  const [, navigate] = useLocation();
  const [stats, setStats] = useState<any>(null);
  const [q, setQ] = useState("");
  const [industry, setIndustry] = useState("");
  const [remote, setRemote] = useState("");
  const [jobs, setJobs] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [alertBusy, setAlertBusy] = useState(false);

  useEffect(() => { api.publicStats().then(setStats).catch(() => {}); }, []);

  // The public jobs API reads `remote` with values remote|hybrid|onsite.
  function apiRemote(v: string) {
    return v === "on_site" ? "onsite" : v;
  }

  async function load(p = 0, ind?: string, rem?: string) {
    setLoading(true);
    try {
      const r: any = await api.publicJobs({ q, industry: ind ?? industry, remote: apiRemote(rem ?? remote), page: p, limit: 20 });
      setJobs(r.jobs || []);
      setTotal(r.total || 0);
      setPage(p);
    } catch { setJobs([]); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(0); }, []);

  async function createAlert() {
    const filters: any = {};
    if (q.trim()) filters.q = q.trim();
    if (industry) filters.industry = industry;
    if (apiRemote(remote)) filters.remote = apiRemote(remote);
    if (!Object.keys(filters).length) {
      toast.push({ kind: "info", title: "Set a filter first", message: "Search a keyword, pick an industry or work style — then tap 🔔 Alert me." });
      return;
    }
    if (!api.isUserSession()) {
      try { localStorage.setItem("pending_alert", JSON.stringify(filters)); } catch { /* ignore */ }
      toast.push({ kind: "info", title: "One quick step", message: "Create a free account and we'll turn this search into an email alert." });
      navigate("/signup");
      return;
    }
    setAlertBusy(true);
    try {
      const r: any = await api.createAlert(filters);
      toast.push({ kind: "success", title: "🔔 Alert on", message: `We'll email you when new jobs match ${r.name || "this search"}. Manage alerts anytime from Matches.` });
    } catch (e: any) {
      toast.push({ kind: "error", title: "Alert failed", message: e?.body?.message || e?.body?.error || e?.message });
    } finally { setAlertBusy(false); }
  }

  function filterByIndustry(i: string) {
    setIndustry(i);
    document.getElementById("browse")?.scrollIntoView({ behavior: "smooth", block: "start" });
    load(0, i);
  }

  const industries = useMemo(() => stats?.industries || [], [stats]);

  return (
    <div className="col" style={{ gap: 24, paddingBottom: 24 }}>
      {/* ── Hero ── */}
      <section className="hero">
        <div className="hero-inner">
          <div className="hero-badge">✨ Free forever · No credit card · Every industry</div>
          <h1>Every job.<br />Matched to <span className="grad">you</span>.</h1>
          <p className="lead">
            We scan thousands of public job postings every day — nurses, drivers, developers,
            designers, accountants, and everything in between. Upload your resume once and our
            engine scores every posting against your background.
          </p>
          <div className="hero-cta">
            <Link href="/ats-mirror"><button className="btn btn-primary">🪞 Mirror my resume — free</button></Link>
            <Link href="/studio"><button className="btn" style={{ color: "#fff", borderColor: "rgba(255,255,255,.3)", background: "rgba(255,255,255,.08)" }}>⚡ Check my resume</button></Link>
            <a href="#browse"><button className="btn" style={{ color: "#fff", borderColor: "rgba(255,255,255,.3)", background: "rgba(255,255,255,.08)" }}>Browse jobs</button></a>
          </div>
          <p className="hero-note">No account needed for your first check. All industries. Unsubscribe in one click.</p>
          {stats && (
            <div className="hero-stats">
              <div className="hero-stat"><b>{Number(stats.active_jobs || 0).toLocaleString()}</b><span>active postings</span></div>
              <div className="hero-stat"><b>{Number(stats.jobs_today || 0).toLocaleString()}</b><span>new today</span></div>
              <div className="hero-stat"><b>{Number(stats.companies || 0).toLocaleString()}</b><span>companies</span></div>
              <div className="hero-stat"><b>{Number(stats.industries?.length || 0)}</b><span>industries</span></div>
            </div>
          )}
        </div>
      </section>

      {/* ── Fresh today: real value above the fold ── */}
      {jobs.length > 0 && (
        <section className="col" style={{ gap: 10 }}>
          <div className="row" style={{ alignItems: "baseline", justifyContent: "space-between" }}>
            <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>🔥 Fresh on the board</h2>
            <a href="#browse" className="sm" style={{ color: "var(--accent)", fontWeight: 600 }}>Browse all →</a>
          </div>
          <div className="fresh-strip">
            {jobs.slice(0, 8).map((j) => (
              <div key={j.id} className="card card-tight fresh-card">
                <div className="fresh-title">{cleanTitle(j.title)}</div>
                <div className="sm muted">
                  {j.company_name}
                  {j.location ? ` · ${j.location}` : ""}
                  {j.remote_policy === "remote" ? " · 🌐 remote" : ""}
                </div>
                {fmtSalary(j) && (
                  <div className="sm" style={{ fontWeight: 700, color: "var(--good)" }}>{fmtSalary(j)}</div>
                )}
                <div style={{ marginTop: "auto", paddingTop: 6 }}>
                  {j.url
                    ? <a href={j.url} target="_blank" rel="noreferrer"><button className="btn btn-ghost btn-sm">Apply →</button></a>
                    : <span className="sm muted">Details in browser ↓</span>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Industries ── */}
      <section className="col" style={{ gap: 12 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0, textAlign: "center" }}>Not just tech. Every industry.</h2>
        <div className="chip-row">
          {industries.slice(0, 10).map((ind: any) => (
            <button key={ind.name} className="chip" onClick={() => filterByIndustry(ind.name)}
              style={{ cursor: "pointer", background: industry === ind.name ? "var(--accent-soft)" : undefined }}>
              {ind.name}
            </button>
          ))}
          <span className="chip" style={{ borderStyle: "dashed" }}>+ more</span>
        </div>
      </section>

      {/* ── Free toolkit: everything, no account needed ── */}
      <section className="col" style={{ gap: 12 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0, textAlign: "center" }}>The free toolkit</h2>
        <p className="sm muted" style={{ margin: 0, textAlign: "center" }}>Every tool is free. Most need no account at all.</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
          {[
            { icon: "🪞", title: "ATS Mirror", desc: "See your resume the way the robots see it. 9-dimension audit + rewritten ATS-safe version.", href: "/ats-mirror", tag: "NEW" },
            { icon: "🎯", title: "Resume Studio", desc: "Tailor your resume to any role and draft a cover letter in seconds.", href: "/studio", tag: "FREE" },
            { icon: "🤖", title: "AI Resume Review", desc: "A 0–100 hireability score with honest strengths, gaps, and fixes.", href: "/review", tag: "FREE" },
            { icon: "🔔", title: "Job Alerts", desc: "New matches in your inbox daily. One-click unsubscribe, always.", href: "/signup", tag: "FREE" },
            { icon: "💬", title: "AI Job Chat", desc: "Ask for jobs in plain English. The AI searches live postings and scores the fit.", href: "/signup", tag: "FREE" },
          ].map((t) => (
            <Link key={t.title} href={t.href} style={{ textDecoration: "none", color: "inherit" }}>
              <div className="card card-tight" style={{ height: "100%", cursor: "pointer" }}>
                <div style={{ fontSize: 28 }}>{t.icon}</div>
                <div style={{ fontWeight: 800, margin: "8px 0 4px" }}>{t.title} <span className="tag tag-violet xs">{t.tag}</span></div>
                <p className="sm muted" style={{ margin: 0 }}>{t.desc}</p>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* ── ATS Mirror band ── */}
      <section className="card row" style={{ gap: 16, alignItems: "center", flexWrap: "wrap", padding: 24, borderTop: "3px solid var(--accent)" }}>
        <div style={{ fontSize: 40 }}>🪞</div>
        <div className="col" style={{ gap: 4, flex: "1 1 260px" }}>
          <h3 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>New: ATS Mirror <span className="tag tag-violet sm">free</span></h3>
          <p className="sm muted" style={{ margin: 0 }}>See your resume the way the robots see it — a 0–100 ATS-readiness score across 9 dimensions, every fix explained, plus a rewritten ATS-safe version you can download as PDF, Word, or text.</p>
        </div>
        <Link href="/ats-mirror"><button className="btn btn-primary">Run the mirror →</button></Link>
      </section>

      {/* ── AI review band ── */}
      <section className="card row" style={{ gap: 16, alignItems: "center", flexWrap: "wrap", padding: 24 }}>
        <div style={{ fontSize: 40 }}>🤖</div>
        <div className="col" style={{ gap: 4, flex: "1 1 260px" }}>
          <h3 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>New: AI resume review</h3>
          <p className="sm muted" style={{ margin: 0 }}>Our AI reads your resume like a hiring manager — a 0–100 score plus honest strengths, gaps, missing keywords, and quick fixes.</p>
        </div>
        <Link href="/review"><button className="btn btn-primary">Try it free →</button></Link>
      </section>

      {/* ── Browser ── */}
      <section id="browse" className="col" style={{ gap: 12 }}>
        <div className="row" style={{ alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <h2 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>🔎 Browse all jobs</h2>
          {industry && (
            <button className="chip" onClick={() => filterByIndustry("")} style={{ cursor: "pointer" }}
              title="Clear industry filter">
              {industry} ✕
            </button>
          )}
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input className="input" style={{ flex: "2 1 220px" }} placeholder="Search title, company, keyword…" value={q}
            onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") load(0); }} />
          <select className="input" style={{ flex: "1 1 160px" }} value={industry}
            onChange={(e) => { const v = e.target.value; setIndustry(v); load(0, v); }}>
            <option value="">All industries</option>
            {industries.map((i: any) => <option key={i.name} value={i.name}>{i.name} ({Number(i.jobs).toLocaleString()})</option>)}
          </select>
          <select className="input" style={{ flex: "1 1 140px" }} value={remote}
            onChange={(e) => { const v = e.target.value; setRemote(v); load(0, undefined, v); }}>
            <option value="">Any work style</option>
            <option value="remote">Remote</option>
            <option value="hybrid">Hybrid</option>
            <option value="on_site">On-site</option>
          </select>
          <button className="btn btn-primary" onClick={() => load(0)}>{loading ? "⏳ Searching…" : "Search"}</button>
          <button className="btn" onClick={createAlert} disabled={alertBusy} title="Email me when new jobs match these filters">
            {alertBusy ? "…" : "🔔 Alert me"}
          </button>
        </div>

        <div className="col" style={{ gap: 8 }}>
          {jobs.map((j) => (
            <div key={j.id} className="card card-tight">
              <div className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{cleanTitle(j.title)}</div>
                  <div className="sm muted">{j.company_name}{j.industry ? ` · ${j.industry}` : ""}{j.location ? ` · ${j.location}` : ""}{j.remote_policy === "remote" ? " · 🌐 remote" : ""}{fmtSalary(j) ? ` · ${fmtSalary(j)}` : ""}</div>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  {j.employment_type === "contract" && <span className="pill">contract</span>}
                  {j.url && <a href={j.url} target="_blank" rel="noreferrer"><button className="btn btn-ghost">Apply →</button></a>}
                </div>
              </div>
            </div>
          ))}
          {!jobs.length && !loading && <div className="card card-tight muted">No jobs match. Try a different search.</div>}
        </div>

        {total > 20 && (
          <div className="row" style={{ gap: 8, justifyContent: "center" }}>
            <button className="btn" disabled={page === 0} onClick={() => load(page - 1)}>← Prev</button>
            <span className="sm muted" style={{ alignSelf: "center" }}>Page {page + 1} of {Math.ceil(total / 20)}</span>
            <button className="btn" disabled={(page + 1) * 20 >= total} onClick={() => load(page + 1)}>Next →</button>
          </div>
        )}
      </section>

      {/* ── Newsletter subscribe ── */}
      <section className="card" style={{ padding: 24, textAlign: "center", borderTop: "3px solid var(--good)" }}>
        <div style={{ fontSize: 32 }}>📬</div>
        <h3 style={{ fontSize: 18, fontWeight: 800, margin: "8px 0 4px" }}>Get the daily job drop</h3>
        <p className="sm muted" style={{ margin: "0 0 14px", maxWidth: 440, marginLeft: "auto", marginRight: "auto" }}>
          Fresh postings in your inbox every morning. Free forever, one-click unsubscribe in every email.
        </p>
        <SubscribeBox />
      </section>

      {/* ── CTA ── */}
      <section className="hero">
        <div className="hero-inner" style={{ padding: "32px 24px" }}>
          <h2 style={{ fontSize: 28, fontWeight: 800, margin: 0, letterSpacing: -0.5 }}>Stop scrolling. Start matching.</h2>
          <p className="lead" style={{ fontSize: 15 }}>
            Create a free account, paste your resume, and get a ranked shortlist plus a daily email of new
            matches — nurse, driver, designer, developer, or anything else.
          </p>
          <div className="hero-cta">
            <Link href="/signup"><button className="btn btn-primary">Get my matches →</button></Link>
          </div>
        </div>
      </section>
    </div>
  );
}
