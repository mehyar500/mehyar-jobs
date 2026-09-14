import { useEffect, useState } from "react";
import { Link } from "wouter";
import { api } from "../lib/api";
import { useToast } from "../lib/toast";

export default function Run() {
  const toast = useToast();
  const [me, setMe] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [filename, setFilename] = useState("");
  const [base64, setBase64] = useState("");
  const [mime, setMime] = useState("");
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<any>(null);

  useEffect(() => {
    if (!api.isUserSession()) { setLoading(false); return; }
    api.me().then(setMe).catch(() => setMe({ error: true })).finally(() => setLoading(false));
  }, []);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 3_000_000) { toast.push({ kind: "error", title: "File too large", message: "Resume must be under 3MB." }); return; }
    const reader = new FileReader();
    reader.onload = () => {
      if (/\.(txt|md|text)$/i.test(f.name)) {
        setText(String(reader.result || ""));
        setBase64(""); setMime(""); setFilename("");
        toast.push({ kind: "success", title: "Resume loaded", message: "Text extracted — review below, then save." });
      } else {
        const result = String(reader.result || "");
        setBase64(result.split(",")[1] || "");
        setMime(f.type || "application/pdf");
        setFilename(f.name);
        toast.push({ kind: "success", title: "File attached", message: `${f.name} — now paste the text below too, then save.` });
      }
    };
    if (/\.(txt|md|text)$/i.test(f.name)) reader.readAsText(f);
    else reader.readAsDataURL(f);
  }

  async function saveResume() {
    if (!text.trim()) { toast.push({ kind: "error", title: "Resume text required", message: "Paste your resume text — matching runs on the text." }); return; }
    setSaving(true);
    try {
      const r = await api.saveResume({ text, filename, mime, base64, current_title: title });
      toast.push({ kind: "success", title: "Resume saved ✅", message: `Extracted ${r.keywords || 0} keywords.` });
      setMe(await api.me());
    } catch (e: any) {
      toast.push({ kind: "error", title: "Save failed", message: e.body?.error || e.message });
    } finally { setSaving(false); }
  }

  async function run() {
    setRunning(true);
    setResult(null);
    try {
      const r = await api.runResume();
      setResult(r);
      setMe(await api.me());
      toast.push({ kind: "success", title: "Done 🎯", message: `${r.matches} matches in ${r.duration_ms}ms.` });
    } catch (e: any) {
      toast.push({ kind: "error", title: "Run failed", message: e.body?.error || e.message });
    } finally { setRunning(false); }
  }

  if (loading) return <div className="card">Loading…</div>;
  if (!api.isUserSession()) {
    return (
      <div className="col" style={{ gap: 16, maxWidth: 520, margin: "0 auto" }}>
        <div className="card" style={{ textAlign: "center", padding: 40 }}>
          <h1 className="h1">🎯 Run the board against your resume</h1>
          <p className="sm muted" style={{ marginTop: 8 }}>
            Free for members: paste your resume, we score every active job against it and email you daily matches. Create an account (or log in) to continue.
          </p>
          <div className="row" style={{ gap: 8, justifyContent: "center", marginTop: 16 }}>
            <Link href="/signup"><button className="btn btn-primary" style={{ padding: "10px 20px" }}>Create free account</button></Link>
            <Link href="/login"><button className="btn">Log in</button></Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="col" style={{ gap: 16, maxWidth: 760, margin: "0 auto", paddingBottom: 48 }}>
      <div className="card">
        <h1 className="h1">📄 Your resume</h1>
        <p className="sm muted" style={{ marginTop: 4 }}>
          {me?.has_resume
            ? `Resume on file (${me.keywords} keywords${me.last_run_at ? ` · last run ${me.last_run_at.slice(0, 16).replace("T", " ")}` : ""}).`
            : "No resume yet — upload or paste it below to unlock matching."}
          {" "}{me?.newsletter_opt_in === 0 && "⚠️ Newsletter is off — turn it on in Account to keep getting daily matches."}
        </p>
      </div>

      <div className="card col" style={{ gap: 12 }}>
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <label className="btn" style={{ cursor: "pointer" }}>
            📎 Choose file (PDF / DOCX / TXT)
            <input type="file" accept="application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.txt,.md" onChange={onFile} style={{ display: "none" }} />
          </label>
          {filename && <span className="sm muted">{filename} attached</span>}
        </div>
        <label className="col" style={{ gap: 4 }}>
          <span className="sm" style={{ fontWeight: 600 }}>Resume text <span className="muted">(required — paste from your CV)</span></span>
          <textarea className="input" rows={10} value={text} onChange={(e) => setText(e.target.value)}
            placeholder={"Paste your full resume text here…\n\nName\nTitle\nExperience\nSkills…"} />
        </label>
        <label className="col" style={{ gap: 4 }}>
          <span className="sm" style={{ fontWeight: 600 }}>Current / target title</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={me?.current_title || "Registered Nurse, Software Engineer…"} />
        </label>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-primary" onClick={saveResume} disabled={saving}>{saving ? "Saving…" : "💾 Save resume"}</button>
          <button className="btn" onClick={run} disabled={running || !me?.has_resume} title={!me?.has_resume ? "Save a resume first" : ""}>
            {running ? "⚙️ Scoring jobs…" : "🚀 Run my resume against all jobs"}
          </button>
        </div>
      </div>

      {result && (
        <div className="card">
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>🎯 Your top matches ({result.matches} scored ≥35)</h2>
          <div className="col" style={{ gap: 8, marginTop: 12 }}>
            {result.top.map((m: any) => (
              <div key={m.job_id} className="row" style={{ justifyContent: "space-between", gap: 8, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{m.title}</div>
                  <div className="sm muted">{m.company}{m.location ? ` · ${m.location}` : ""}</div>
                </div>
                <div className="row" style={{ gap: 8, alignItems: "center" }}>
                  <span className="pill">{m.score}/100</span>
                  {m.url && <a href={m.url} target="_blank" rel="noreferrer"><button className="btn btn-ghost">Apply →</button></a>}
                </div>
              </div>
            ))}
          </div>
          <Link href="/matches"><button className="btn" style={{ marginTop: 12 }}>See all matches →</button></Link>
        </div>
      )}

      {me?.match_summary && me.match_summary.total > 0 && !result && (
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <div><strong>{me.match_summary.total}</strong> saved matches ({me.match_summary.strong} strong)</div>
            <Link href="/matches"><button className="btn btn-primary">View matches →</button></Link>
          </div>
        </div>
      )}
    </div>
  );
}
