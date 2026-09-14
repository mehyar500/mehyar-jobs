import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { api } from "../lib/api";

function scoreColor(s: number) {
  if (s >= 75) return "var(--good)";
  if (s >= 55) return "var(--warn)";
  return "var(--bad)";
}

function gradeLabel(s: number) {
  if (s >= 85) return { t: "ATS-proof", d: "This resume sails through parsers and keyword screens." };
  if (s >= 70) return { t: "Strong", d: "Solid bones — a few targeted fixes and it's elite." };
  if (s >= 55) return { t: "Needs work", d: "A real ATS would under-rank this. The fixes below change that." };
  if (s >= 40) return { t: "At risk", d: "Likely filtered out before a human ever sees it." };
  return { t: "Invisible to robots", d: "This resume is getting silently discarded. Let's fix it." };
}

function ScoreRing({ score, size = 168 }: { score: number; size?: number }) {
  const r = 62;
  const c = 2 * Math.PI * r;
  const color = scoreColor(score);
  const g = gradeLabel(score);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 22, flexWrap: "wrap" }}>
      <div style={{ position: "relative", width: size, height: size }}>
        <svg width={size} height={size} viewBox="0 0 140 140">
          <circle cx="70" cy="70" r={r} fill="none" stroke="var(--border)" strokeWidth="12" />
          <circle cx="70" cy="70" r={r} fill="none" stroke={color} strokeWidth="12" strokeLinecap="round"
            strokeDasharray={`${(score / 100) * c} ${c}`} transform="rotate(-90 70 70)" />
        </svg>
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontSize: 40, fontWeight: 800, lineHeight: 1 }}>{score}</span>
          <span className="xs muted">/ 100</span>
        </div>
      </div>
      <div style={{ minWidth: 220, flex: 1 }}>
        <div className="xs" style={{ fontWeight: 800, letterSpacing: ".1em", color, textTransform: "uppercase" }}>ATS-readiness</div>
        <div style={{ fontSize: 26, fontWeight: 800, margin: "4px 0" }}>{g.t}</div>
        <p className="sm muted" style={{ margin: 0, maxWidth: 420 }}>{g.d}</p>
      </div>
    </div>
  );
}

function DimBar({ name, score, note }: { name: string; score: number; note: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <span className="sm" style={{ fontWeight: 700 }}>{name}</span>
        <span className="sm" style={{ fontWeight: 800, color: scoreColor(score) }}>{score}</span>
      </div>
      <div style={{ height: 8, borderRadius: 99, background: "var(--border)", marginTop: 5, overflow: "hidden" }}>
        <div style={{ width: `${score}%`, height: "100%", borderRadius: 99, background: scoreColor(score), transition: "width .8s ease" }} />
      </div>
      {note ? <div className="xs muted" style={{ marginTop: 3 }}>{note}</div> : null}
    </div>
  );
}

const SEV = {
  critical: { icon: "🔴", label: "Critical", color: "var(--bad)" },
  warning: { icon: "🟡", label: "Warning", color: "var(--warn)" },
  pass: { icon: "🟢", label: "Passing", color: "var(--good)" },
} as const;

function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
}

function resumeToDocHtml(text: string, title: string) {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = esc(text).split("\n").map((ln) => {
    if (/^[A-Z][A-Z\s&|•\-–—]{3,}$/.test(ln.trim()) && ln.trim().length < 40) {
      return `<h2 style="font-size:13pt;color:#1e1b4b;border-bottom:2px solid #7c3aed;margin:14pt 0 6pt;">${ln.trim()}</h2>`;
    }
    if (!ln.trim()) return "<p style='margin:4pt 0;'>&nbsp;</p>";
    return `<p style="margin:3pt 0;">${ln.trim().startsWith("•") || ln.trim().startsWith("-") ? "• " + esc(ln.trim().slice(1).trim()) : ln}</p>`;
  }).join("\n");
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body style="font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#18181b;max-width:7in;">${body}</body></html>`;
}

// Lazy-load pdfmake from CDN only when the user asks for a PDF.
let pdfmakePromise: Promise<any> | null = null;
function loadPdfmake(): Promise<any> {
  if (!(window as any).pdfMake) {
    if (!pdfmakePromise) {
      pdfmakePromise = new Promise((resolve, reject) => {
        const s1 = document.createElement("script");
        s1.src = "https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.12/pdfmake.min.js";
        s1.onload = () => {
          const s2 = document.createElement("script");
          s2.src = "https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.12/vfs_fonts.js";
          s2.onload = () => resolve((window as any).pdfMake);
          s2.onerror = reject;
          document.head.appendChild(s2);
        };
        s1.onerror = reject;
        document.head.appendChild(s1);
      });
    }
    return pdfmakePromise;
  }
  return Promise.resolve((window as any).pdfMake);
}

function buildReportPdf(audit: any, targetRole: string | null) {
  const g = gradeLabel(audit.score);
  const sevColor = (s: string) => s === "critical" ? "#ef4444" : s === "warning" ? "#f59e0b" : "#10b981";
  const content: any[] = [
    { text: "ATS MIRROR", style: "kicker" },
    { text: "See your resume the way the robots see it", style: "sub" },
    { text: `ATS-Readiness Score: ${audit.score}/100 — ${g.t}`, style: "score" },
    { text: audit.verdict || "", style: "verdict", margin: [0, 4, 0, 12] },
  ];
  if (targetRole) content.push({ text: `Target role: ${targetRole}`, style: "muted", margin: [0, 0, 0, 10] });
  content.push({ text: "Dimension scores", style: "h2" });
  content.push({
    table: {
      widths: ["*", 50],
      body: [
        [{ text: "Dimension", style: "th" }, { text: "Score", style: "th" }],
        ...(audit.sections || []).map((s: any) => [s.name, String(s.score)]),
      ],
    },
    layout: "lightHorizontalLines",
    margin: [0, 4, 0, 12],
  });
  const st = audit.stats || {};
  content.push({
    text: `Words: ${st.word_count || 0}   •   Bullets: ${st.bullets_total || 0}   •   Quantified: ${st.bullets_quantified || 0}   •   Weak phrases: ${st.weak_verb_phrases || 0}`,
    style: "muted", margin: [0, 0, 0, 12],
  });
  content.push({ text: "Findings & fixes", style: "h2" });
  for (const i of audit.issues || []) {
    content.push({
      columns: [
        { width: 70, text: (i.severity || "warning").toUpperCase(), color: sevColor(i.severity), bold: true, fontSize: 9 },
        { width: "*", stack: [{ text: i.title, bold: true, fontSize: 11 }, { text: i.detail, fontSize: 10, margin: [0, 2, 0, 2] }, { text: "Fix: " + i.fix, fontSize: 10, italics: true }] },
      ],
      margin: [0, 0, 0, 8],
    });
  }
  if ((audit.missing_keywords || []).length) {
    content.push({ text: "Missing keywords (add where truthful)", style: "h2" });
    content.push({ text: audit.missing_keywords.join("  •  "), fontSize: 10, margin: [0, 4, 0, 12] });
  }
  if ((audit.strong_keywords || []).length) {
    content.push({ text: "Keywords already working for you", style: "h2" });
    content.push({ text: audit.strong_keywords.join("  •  "), fontSize: 10, margin: [0, 4, 0, 0] });
  }
  content.push({ text: "Generated by mehyar.jobs ATS Mirror — free at jobs.mehyar.us/ats-mirror", style: "footer", margin: [0, 18, 0, 0] });
  return {
    content,
    styles: {
      kicker: { fontSize: 10, bold: true, color: "#7c3aed", letterSpacing: 2 },
      sub: { fontSize: 12, color: "#71717a", margin: [0, 2, 0, 10] },
      score: { fontSize: 16, bold: true, margin: [0, 0, 0, 4] },
      verdict: { fontSize: 11, italics: true },
      h2: { fontSize: 13, bold: true, color: "#1e1b4b", margin: [0, 8, 0, 4] },
      th: { bold: true, fontSize: 10 },
      muted: { fontSize: 10, color: "#71717a" },
      footer: { fontSize: 9, color: "#a1a1aa" },
    },
    defaultStyle: { fontSize: 11 },
  };
}

const LOADING_STEPS = [
  "Parsing your document…",
  "Simulating Workday, Taleo & Greenhouse parsers…",
  "Scoring 9 ATS dimensions…",
  "Hunting missing keywords…",
  "Rewriting your resume the ATS-safe way…",
];

export default function AtsMirror() {
  const [file, setFile] = useState<File | null>(null);
  const [pasted, setPasted] = useState("");
  const [targetRole, setTargetRole] = useState("");
  const [parsing, setParsing] = useState(false);
  const [resumeText, setResumeText] = useState("");
  const [busy, setBusy] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const reportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!busy) return;
    setStepIdx(0);
    const t = setInterval(() => setStepIdx((i) => (i + 1) % LOADING_STEPS.length), 2600);
    return () => clearInterval(t);
  }, [busy]);

  async function onFile(f: File | undefined) {
    if (!f) return;
    setFile(f);
    setErr(null);
    setParsing(true);
    try {
      const r: any = await api.parseResume(f);
      const text = String(r.text || "");
      if (text.trim().length < 200) throw new Error("Couldn't extract enough text — try pasting it below instead.");
      setResumeText(text);
    } catch (e: any) {
      setErr(e?.message || "Couldn't read that file.");
      setFile(null);
    } finally {
      setParsing(false);
    }
  }

  async function runMirror() {
    const text = (pasted.trim() || resumeText).trim();
    if (text.length < 200) { setErr("Upload your resume or paste the text first (needs a bit more than a few lines)."); return; }
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const r: any = await api.atsMirror({ resume_text: text.slice(0, 12000), target_role: targetRole.trim() || undefined });
      setResult(r);
      setTimeout(() => reportRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
    } catch (e: any) {
      setErr(e?.message || "The mirror failed — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function downloadPdf() {
    if (!result?.audit) return;
    setPdfBusy(true);
    try {
      const pdfMake = await loadPdfmake();
      pdfMake.createPdf(buildReportPdf(result.audit, result.target_role)).download("ats-mirror-report.pdf");
    } catch {
      setErr("PDF engine failed to load — check your connection and try again.");
    } finally {
      setPdfBusy(false);
    }
  }

  const audit = result?.audit;
  const quantifiedPct = audit?.stats?.bullets_total
    ? Math.round((100 * (audit.stats.bullets_quantified || 0)) / audit.stats.bullets_total)
    : 0;

  return (
    <div className="container" style={{ maxWidth: 880, paddingBottom: 60 }}>
      {/* HERO */}
      <div style={{ textAlign: "center", padding: "36px 0 20px" }}>
        <div style={{ fontSize: 44 }}>🪞</div>
        <h1 className="h1" style={{ margin: "8px 0 6px" }}>ATS Mirror</h1>
        <p className="muted" style={{ maxWidth: 560, margin: "0 auto", fontSize: 16 }}>
          See your resume the way the robots see it. A deep AI audit across the 9 dimensions
          applicant tracking systems actually score — plus a rewritten, ATS-safe version you can download.
        </p>
        <div className="xs" style={{ marginTop: 10 }}>
          <span className="tag tag-violet">FREE</span>{" "}
          <span className="muted">1 mirror per guest · 10/day with a free account · no signup needed to try</span>
        </div>
      </div>

      {/* INPUT */}
      {!result && (
        <div className="card" style={{ marginTop: 8 }}>
          <div
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files?.[0]); }}
            style={{
              border: "2px dashed var(--border)", borderRadius: 12, padding: "28px 16px",
              textAlign: "center", cursor: "pointer", background: "var(--bg)",
            }}
          >
            <input ref={fileRef} type="file" accept=".pdf,.doc,.docx,.txt" style={{ display: "none" }}
              onChange={(e) => onFile(e.target.files?.[0])} />
            {parsing ? (
              <p className="sm muted">Reading your file…</p>
            ) : file ? (
              <><p style={{ fontWeight: 700, margin: 0 }}>📄 {file.name}</p>
                <p className="xs muted" style={{ margin: "6px 0 0" }}>Looks good — {resumeText.length.toLocaleString()} characters extracted. Click to replace.</p></>
            ) : (
              <><p style={{ fontWeight: 700, margin: 0 }}>Drop your resume here, or click to browse</p>
                <p className="xs muted" style={{ margin: "6px 0 0" }}>PDF, DOC, DOCX or TXT</p></>
            )}
          </div>

          <div className="row" style={{ alignItems: "center", margin: "14px 0", gap: 10 }}>
            <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
            <span className="xs muted">or paste the text</span>
            <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
          </div>
          <textarea
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder="Paste your resume text here…"
            rows={5}
            style={{ width: "100%", borderRadius: 10, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--fg)", padding: 10, fontSize: 14 }}
          />

          <label className="sm" style={{ display: "block", fontWeight: 700, margin: "14px 0 6px" }}>
            Target role <span className="muted" style={{ fontWeight: 400 }}>(optional — sharpens the keyword analysis)</span>
          </label>
          <input
            value={targetRole}
            onChange={(e) => setTargetRole(e.target.value)}
            placeholder="e.g. Senior Backend Engineer, ICU Nurse, Marketing Manager…"
            style={{ width: "100%", borderRadius: 10, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--fg)", padding: "10px 12px", fontSize: 14 }}
          />

          {err && <p className="sm" style={{ color: "var(--bad)", margin: "12px 0 0" }}>{err}</p>}

          <button className="btn btn-primary" disabled={busy || parsing} onClick={runMirror}
            style={{ width: "100%", marginTop: 16, padding: "13px", fontSize: 16, fontWeight: 800 }}>
            {busy ? LOADING_STEPS[stepIdx] : "🪞 Run the mirror"}
          </button>
          {busy && (
            <div style={{ height: 6, borderRadius: 99, background: "var(--border)", marginTop: 12, overflow: "hidden" }}>
              <div style={{ height: "100%", width: "40%", borderRadius: 99, background: "var(--accent)", animation: "atsload 1.4s ease-in-out infinite" }} />
            </div>
          )}
          <style>{`@keyframes atsload { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }`}</style>
        </div>
      )}

      {/* REPORT */}
      {audit && (
        <div ref={reportRef} style={{ marginTop: 8 }}>
          <div className="card" style={{ borderTop: "4px solid var(--accent)" }}>
            <ScoreRing score={audit.score} />
            {audit.verdict && (
              <p style={{ fontSize: 16, fontStyle: "italic", margin: "16px 0 0", padding: "12px 14px", background: "var(--bg)", borderRadius: 10, borderLeft: "3px solid var(--accent)" }}>
                “{audit.verdict}”
              </p>
            )}
            <div className="row" style={{ gap: 8, marginTop: 14, flexWrap: "wrap" }}>
              <span className="tag sm">📝 {audit.stats?.word_count?.toLocaleString() || 0} words</span>
              <span className="tag sm">• {audit.stats?.bullets_total || 0} bullets</span>
              <span className="tag sm">📊 {quantifiedPct}% quantified</span>
              {(audit.stats?.weak_verb_phrases || 0) > 0 && (
                <span className="tag sm">⚠️ {audit.stats.weak_verb_phrases} weak phrases</span>
              )}
            </div>
          </div>

          {/* DIMENSIONS */}
          <h2 className="h2" style={{ margin: "26px 0 12px" }}>The 9 dimensions</h2>
          <div className="card">
            {(audit.sections || []).map((s: any, i: number) => (
              <DimBar key={i} name={s.name} score={s.score} note={s.note} />
            ))}
          </div>

          {/* ISSUES */}
          <h2 className="h2" style={{ margin: "26px 0 12px" }}>Findings & fixes</h2>
          <div className="col" style={{ gap: 10 }}>
            {(audit.issues || []).map((iss: any, i: number) => {
              const sev = (SEV as any)[iss.severity] || SEV.warning;
              return (
                <div key={i} className="card card-tight" style={{ borderLeft: `4px solid ${sev.color}` }}>
                  <div className="row" style={{ gap: 8, alignItems: "center" }}>
                    <span>{sev.icon}</span>
                    <span style={{ fontWeight: 800 }}>{iss.title}</span>
                    <span className="xs muted" style={{ marginLeft: "auto", textTransform: "uppercase", letterSpacing: ".06em" }}>{sev.label}</span>
                  </div>
                  <p className="sm" style={{ margin: "8px 0" }}>{iss.detail}</p>
                  <p className="sm" style={{ margin: 0, padding: "8px 10px", background: "var(--bg)", borderRadius: 8 }}>
                    <strong>Fix → </strong>{iss.fix}
                  </p>
                </div>
              );
            })}
          </div>

          {/* KEYWORDS */}
          <div className="row" style={{ gap: 12, marginTop: 26, alignItems: "flex-start", flexWrap: "wrap" }}>
            {(audit.missing_keywords || []).length > 0 && (
              <div className="card card-tight" style={{ flex: "1 1 300px" }}>
                <h3 style={{ fontSize: 15, fontWeight: 800, margin: "0 0 8px" }}>🎯 Missing keywords</h3>
                <p className="xs muted" style={{ margin: "0 0 8px" }}>The target role wants these — add them where truthful.</p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {audit.missing_keywords.map((k: string, i: number) => (
                    <span key={i} className="tag sm" style={{ background: "color-mix(in srgb, var(--bad) 12%, transparent)", border: "1px solid var(--bad)" }}>{k}</span>
                  ))}
                </div>
              </div>
            )}
            {(audit.strong_keywords || []).length > 0 && (
              <div className="card card-tight" style={{ flex: "1 1 300px" }}>
                <h3 style={{ fontSize: 15, fontWeight: 800, margin: "0 0 8px" }}>💪 Already working for you</h3>
                <p className="xs muted" style={{ margin: "0 0 8px" }}>Terms the robots already love on your resume.</p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {audit.strong_keywords.map((k: string, i: number) => (
                    <span key={i} className="tag sm" style={{ background: "color-mix(in srgb, var(--good) 12%, transparent)", border: "1px solid var(--good)" }}>{k}</span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* REWRITTEN RESUME */}
          {result.improved_resume && (
            <>
              <h2 className="h2" style={{ margin: "26px 0 12px" }}>✨ Your rewritten resume</h2>
              <div className="card">
                <p className="sm muted" style={{ marginTop: 0 }}>
                  Rewritten ATS-safe with every fix applied. Facts preserved — wording upgraded.
                </p>
                <pre style={{
                  whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: 13.5, lineHeight: 1.55,
                  background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10,
                  padding: 16, maxHeight: 420, overflow: "auto", margin: "0 0 12px",
                }}>{result.improved_resume}</pre>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <button className="btn btn-sm" onClick={() => downloadBlob(result.improved_resume, "resume-ats-ready.txt", "text/plain")}>⬇️ .txt</button>
                  <button className="btn btn-sm" onClick={() => downloadBlob(result.improved_resume, "resume-ats-ready.md", "text/markdown")}>⬇️ .md</button>
                  <button className="btn btn-sm" onClick={() => downloadBlob(resumeToDocHtml(result.improved_resume, "Resume — ATS ready"), "resume-ats-ready.doc", "application/msword")}>⬇️ Word (.doc)</button>
                </div>
              </div>
            </>
          )}

          {/* ACTIONS */}
          <div className="row" style={{ gap: 10, marginTop: 26, flexWrap: "wrap" }}>
            <button className="btn btn-primary" disabled={pdfBusy} onClick={downloadPdf}>
              {pdfBusy ? "Building PDF…" : "📕 Download PDF report"}
            </button>
            <button className="btn" onClick={() => { setResult(null); setFile(null); setPasted(""); setResumeText(""); setErr(null); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
              🪞 Mirror another resume
            </button>
            <Link href="/studio" className="btn">🎯 Open free resume studio →</Link>
          </div>
          {!result.member && (
            <p className="sm muted" style={{ marginTop: 14 }}>
              That was your free guest mirror. <Link href="/signup">Create a free account</Link> for 10 mirrors a day,
              job matching, and alerts.
            </p>
          )}
        </div>
      )}

      {/* STEPS */}
      {!result && (
        <div className="card" style={{ marginTop: 22 }}>
          <h3 style={{ margin: "0 0 8px", fontSize: 16 }}>How the mirror works</h3>
          <ol className="sm muted" style={{ margin: 0, paddingLeft: 20, lineHeight: 1.7 }}>
            <li>Upload your resume — it's parsed exactly like Workday, Taleo, and Greenhouse parse it.</li>
            <li>The AI scores 9 dimensions: parseability, contact, keywords, quantified impact, verbs, format killers, structure, length, seniority signal.</li>
            <li>You get every finding with the exact fix — plus a rewritten resume, ready to download.</li>
          </ol>
        </div>
      )}
    </div>
  );
}
