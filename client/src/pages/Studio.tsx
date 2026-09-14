// Studio.tsx — Free Resume Studio (the free funnel).
// Anonymous visitors: one free fit check (IP-gated) + 3 free AI generations/day.
// Members: unlimited checks, bigger AI allowance. No paywall anywhere.
import { useState } from "react";
import { Link } from "wouter";
import { api } from "../lib/api";
import { useToast } from "../lib/toast";

const INDUSTRY_ICONS: Record<string, string> = {
  healthcare: "🏥", technology: "💻", "financial services": "🏦", finance: "🏦",
  hospitality: "🏨", retail: "🛍️", education: "🎓", logistics: "🚚",
  legal: "⚖️", manufacturing: "🏭", energy: "⚡", media: "🎬",
  airline: "✈️", airlines: "✈️", restaurant: "🍽️", "food & beverage": "🍽️",
  insurance: "🛡️", automotive: "🚗", consulting: "💼", government: "🏛️",
  nonprofit: "🤝", "real estate": "🏠", construction: "🏗️", pharmaceutical: "💊",
};
export function industryIcon(industry?: string | null) {
  const k = String(industry || "").toLowerCase();
  for (const key of Object.keys(INDUSTRY_ICONS)) if (k.includes(key)) return INDUSTRY_ICONS[key];
  return "💼";
}

export function fmtSalary(min: any, max: any, currency?: string | null) {
  const n = (v: any) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : null; };
  const a = n(min), b = n(max);
  if (!a && !b) return null;
  const f = (x: number) => (x >= 1000 ? `$${Math.round(x / 1000)}k` : `$${Math.round(x)}`);
  const cur = currency && String(currency).toUpperCase() !== "USD" ? ` ${currency}` : "";
  if (a && b && a !== b) return `${f(a)}–${f(b)}${cur}`;
  return `${f(a || b!)}${cur}`;
}

export function typeBadge(t?: string | null) {
  const v = String(t || "").toLowerCase();
  if (v === "contract") return { icon: "📝", label: "Contract", cls: "badge-contract" };
  if (v === "temporary") return { icon: "⏳", label: "Temporary", cls: "badge-contract" };
  if (v === "full_time") return { icon: "🏢", label: "Full-time · W-2", cls: "badge-w2" };
  return null;
}

export function remoteBadge(r?: string | null) {
  const v = String(r || "").toLowerCase();
  if (v === "remote") return { icon: "🏠", label: "Remote", cls: "badge-remote" };
  if (v === "hybrid") return { icon: "🔀", label: "Hybrid", cls: "badge-hybrid" };
  return null;
}

function ScoreRing({ score, size = 64 }: { score: number; size?: number }) {
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const r = (size - 10) / 2;
  const c = 2 * Math.PI * r;
  const color = score >= 70 ? "#22c55e" : score >= 50 ? "#eab308" : "#f97316";
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="score-ring">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,.12)" strokeWidth="7" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="7"
        strokeLinecap="round" strokeDasharray={`${c * pct} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x="50%" y="50%" dy=".35em" textAnchor="middle" fill="#fff" fontWeight="800" fontSize={size * 0.28}>{score}</text>
    </svg>
  );
}

function download(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

export default function Studio() {
  const toast = useToast();
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [location, setLocation] = useState("");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [usedUp, setUsedUp] = useState(false);

  const [tailoring, setTailoring] = useState(false);
  const [tailored, setTailored] = useState<any>(null);
  const [showTailored, setShowTailored] = useState(false);

  const [coverJobId, setCoverJobId] = useState<number | "">("");
  const [drafting, setDrafting] = useState(false);
  const [cover, setCover] = useState<any>(null);
  const [showCover, setShowCover] = useState(false);

  const isMember = api.isUserSession();

  const [parsing, setParsing] = useState(false);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 3_000_000) { toast.push({ kind: "error", title: "File too large", message: "Resume must be under 3MB." }); return; }
    setParsing(true);
    try {
      const out = await api.parseResume(f);
      setText(out.text);
      toast.push({ kind: "success", title: "Resume read ✅", message: `${f.name} — ${out.char_count.toLocaleString()} characters extracted. Review below, then run your free check.` });
    } catch (err: any) {
      toast.push({ kind: "error", title: "Couldn't read that file", message: err?.message || "Try a .pdf, .docx, or .txt export." });
    } finally {
      setParsing(false);
      e.target.value = "";
    }
  }

  async function runCheck() {
    if (text.trim().length < 200) {
      toast.push({ kind: "error", title: "Resume needed", message: "Upload a file or paste at least a few paragraphs of your resume." });
      return;
    }
    setChecking(true);
    setResult(null);
    try {
      const r = await api.freeRun(text, title.trim() || undefined, location.trim() || undefined);
      setResult(r);
      toast.push({ kind: "success", title: "Check complete ✅", message: `${r.matches?.length || 0} strong matches out of ${r.total_scored?.toLocaleString()} live jobs.` });
    } catch (e: any) {
      if (e?.body?.error === "free_run_used") {
        setUsedUp(true);
      } else {
        toast.push({ kind: "error", title: "Check failed", message: e.message });
      }
    } finally { setChecking(false); }
  }

  async function tailor() {
    if (text.trim().length < 200) { toast.push({ kind: "error", title: "Resume needed", message: "Paste your resume first." }); return; }
    setTailoring(true);
    try {
      const job = coverJobId !== "" && result?.matches
        ? result.matches.find((m: any) => m.id === coverJobId)
        : null;
      const r = await api.tailorResume({
        resume_text: text,
        target_role: title.trim() || undefined,
        job: job ? { title: job.title, company: job.company_name, description: "" } : undefined,
      });
      setTailored(r);
      setShowTailored(true);
    } catch (e: any) {
      toast.push({ kind: "error", title: "Tailoring failed", message: e.message });
    } finally { setTailoring(false); }
  }

  async function draftCover() {
    if (coverJobId === "") { toast.push({ kind: "error", title: "Pick a job", message: "Choose one of your matched jobs for the cover letter." }); return; }
    if (text.trim().length < 200) { toast.push({ kind: "error", title: "Resume needed", message: "Paste your resume first." }); return; }
    setDrafting(true);
    try {
      const r = await api.coverLetter({ resume_text: text, job_id: Number(coverJobId) });
      setCover(r);
      setShowCover(true);
    } catch (e: any) {
      toast.push({ kind: "error", title: "Draft failed", message: e.message });
    } finally { setDrafting(false); }
  }

  const matches: any[] = result?.matches || [];
  const industries = [...new Set(matches.map((m) => m.company_industry).filter(Boolean))].slice(0, 10);
  const best = matches.length ? matches[0].score : 0;

  return (
    <div className="studio">
      <div className="studio-hero">
        <h1 className="h1">🎯 Free Resume Studio</h1>
        <p className="muted">Drop in your resume — get your fit score against thousands of live jobs, a tailored rewrite, and a cover letter. <strong>100% free, no account needed</strong> for your first check.</p>
        {!isMember && (
          <div className="free-pill">🎁 Free check: {usedUp ? "used — create a free account for unlimited" : "1 per visitor, no signup"}</div>
        )}
      </div>

      {/* Step 1 — input */}
      <section className="card studio-card">
        <h2 className="h2">① Your resume</h2>
        <label className="dropzone">
          <input type="file" accept=".txt,.md,.text,.pdf,.doc,.docx" onChange={onFile} hidden />
          <div className="dz-inner">
            <div className="dz-icon">📄</div>
            <div><strong>Upload your resume</strong> <span className="muted">(PDF / DOCX / TXT — text extracted automatically)</span></div>
            <div className="sm muted">or paste the text below</div>
          </div>
        </label>
        <textarea className="input studio-textarea" rows={9} value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste your resume text here…" />
        <div className="row studio-inputs">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="🎯 Target title (optional) — e.g. Registered Nurse" />
          <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="📍 Location (optional) — e.g. Austin, TX" />
        </div>
        <button className="btn btn-primary btn-lg" onClick={runCheck} disabled={checking || parsing}>
          {parsing ? "⏳ Reading your resume…" : checking ? "⏳ Scoring against live jobs…" : "⚡ Check my fit — free"}
        </button>
        {usedUp && !isMember && (
          <div className="usedup">
            <p>You've used your free check on this device. <strong>Create a free account</strong> for unlimited checks, AI tailoring, and new-match alerts.</p>
            <Link href="/signup"><button className="btn btn-primary">Create free account</button></Link>
          </div>
        )}
      </section>

      {/* Step 2 — results */}
      {result && (
        <section className="studio-results">
          <div className="card studio-summary">
            <ScoreRing score={best} />
            <div>
              <h2 className="h2">Your fit snapshot</h2>
              <p className="muted sm">
                Top fit <strong>{best}/100</strong> · <strong>{matches.length}</strong> strong matches
                from <strong>{Number(result.total_scored || 0).toLocaleString()}</strong> live jobs
                {result.profile?.target_titles?.length ? <> · reading you as <strong>{result.profile.target_titles.slice(0, 2).join(" / ")}</strong></> : null}
              </p>
              {industries.length > 0 && (
                <div className="industry-chips">
                  {industries.map((ind: string) => (
                    <span key={ind} className="chip">{industryIcon(ind)} {ind}</span>
                  ))}
                </div>
              )}
            </div>
          </div>

          <h2 className="h2">② Your top matches</h2>
          <div className="match-grid">
            {matches.map((m: any) => {
              const sal = fmtSalary(m.salary_min, m.salary_max, m.salary_currency);
              const tb = typeBadge(m.employment_type);
              const rb = remoteBadge(m.remote_policy);
              return (
                <article key={m.id} className="match-card">
                  <div className="match-top">
                    <div className="match-icon">{industryIcon(m.company_industry)}</div>
                    <div className="grow">
                      <div className="match-title">{m.title}</div>
                      <div className="sm muted">{m.company_name || "—"}{m.company_industry ? ` · ${m.company_industry}` : ""}</div>
                    </div>
                    <ScoreRing score={m.score} size={52} />
                  </div>
                  <div className="match-badges">
                    {rb && <span className={`badge ${rb.cls}`}>{rb.icon} {rb.label}</span>}
                    {m.location && <span className="badge">📍 {m.location}</span>}
                    {tb && <span className={`badge ${tb.cls}`}>{tb.icon} {tb.label}</span>}
                    {sal && <span className="badge badge-salary">💰 {sal}</span>}
                  </div>
                  {m.url && <a href={m.url} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm match-apply">Apply ↗</a>}
                  {Array.isArray(m.explain) && m.explain.length > 0 && (
                    <details className="sm" style={{ marginTop: 8 }}>
                      <summary style={{ cursor: "pointer", color: "var(--accent)", fontWeight: 600 }}>🔍 Why this fit?</summary>
                      <ul className="muted" style={{ margin: "6px 0 0", paddingLeft: 18, lineHeight: 1.5 }}>
                        {m.explain.map((r: string, i: number) => <li key={i}>{r}</li>)}
                      </ul>
                    </details>
                  )}
                </article>
              );
            })}
          </div>
          {matches.length === 0 && (
            <div className="card"><p className="muted">No strong matches this time — try the AI tailor below to sharpen your resume, then check again with a free account.</p></div>
          )}

          {/* Step 3 — AI studio */}
          <h2 className="h2">③ AI studio — free</h2>
          <div className="studio-ai-grid">
            <div className="card studio-card">
              <h3 className="h3">✨ Tailor my resume</h3>
              <p className="sm muted">Rewrites your resume — tighter bullets, right keywords, ATS-friendly. Preview before you download.</p>
              <button className="btn btn-primary" onClick={tailor} disabled={tailoring}>
                {tailoring ? "⏳ Writing…" : "✨ Generate tailored resume"}
              </button>
              {tailored?.improvements?.length > 0 && (
                <div className="improvements">
                  <h4 className="h4">🔧 Suggested improvements</h4>
                  <ul>{tailored.improvements.map((imp: string, i: number) => <li key={i} className="sm">{imp}</li>)}</ul>
                </div>
              )}
            </div>
            <div className="card studio-card">
              <h3 className="h3">✉️ Cover letter</h3>
              <p className="sm muted">Pick a matched job — get a specific, non-generic letter in seconds.</p>
              <select className="input" value={coverJobId} onChange={(e) => setCoverJobId(e.target.value === "" ? "" : Number(e.target.value))}>
                <option value="">— Choose a matched job —</option>
                {matches.map((m: any) => <option key={m.id} value={m.id}>{m.score} · {m.title} @ {m.company_name}</option>)}
              </select>
              <button className="btn btn-primary" onClick={draftCover} disabled={drafting} style={{ marginTop: 8 }}>
                {drafting ? "⏳ Drafting…" : "✉️ Draft cover letter"}
              </button>
            </div>
          </div>

          {!isMember && (
            <div className="card funnel-nudge">
              <div className="funnel-icon">🚀</div>
              <div>
                <h3 className="h3">Want unlimited checks + alerts when new matches post?</h3>
                <p className="sm muted">Free account: unlimited resume checks, AI tailoring, cover letters, and a digest email whenever strong new matches appear.</p>
              </div>
              <Link href="/signup"><button className="btn btn-primary btn-lg">Create free account</button></Link>
            </div>
          )}
        </section>
      )}

      {/* Tailored resume preview modal */}
      {showTailored && tailored && (
        <div className="modal-backdrop" onClick={() => setShowTailored(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3 className="h3">✨ Your tailored resume</h3>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowTailored(false)}>✕</button>
            </div>
            <pre className="resume-preview">{tailored.tailored_resume}</pre>
            <div className="row modal-actions">
              <button className="btn btn-primary" onClick={() => download("tailored-resume.txt", tailored.tailored_resume)}>⬇️ Download .txt</button>
              <button className="btn btn-ghost" onClick={() => { navigator.clipboard?.writeText(tailored.tailored_resume); toast.push({ kind: "success", title: "Copied ✅", message: "Tailored resume copied to clipboard." }); }}>📋 Copy</button>
            </div>
          </div>
        </div>
      )}

      {/* Cover letter preview modal */}
      {showCover && cover && (
        <div className="modal-backdrop" onClick={() => setShowCover(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3 className="h3">✉️ Cover letter{cover.job ? ` — ${cover.job.title}${cover.job.company ? ` @ ${cover.job.company}` : ""}` : ""}</h3>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowCover(false)}>✕</button>
            </div>
            <pre className="resume-preview">{cover.cover_letter}</pre>
            <div className="row modal-actions">
              <button className="btn btn-primary" onClick={() => download("cover-letter.txt", cover.cover_letter)}>⬇️ Download .txt</button>
              <button className="btn btn-ghost" onClick={() => { navigator.clipboard?.writeText(cover.cover_letter); toast.push({ kind: "success", title: "Copied ✅", message: "Cover letter copied to clipboard." }); }}>📋 Copy</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
