import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { api, getToken } from "../lib/api";

type Msg = {
  role: "user" | "assistant";
  content: string;
  matches?: any[];
  searched?: boolean;
  cta?: { label: string; href: string };
};

const LS_RESUME = "mhj_chat_resume";
const QUICK = [
  "Find remote jobs for me",
  "Nursing roles near me",
  "Entry-level tech jobs",
  "Highest-paying analyst roles",
];

function fmtSalary(m: any) {
  if (m.salary_min || m.salary_max) {
    const f = (n: any) => (n ? `$${Number(n).toLocaleString()}` : "");
    return `${f(m.salary_min)}${m.salary_min && m.salary_max ? "–" : ""}${f(m.salary_max)}`;
  }
  return "";
}

function scoreColor(s: number) {
  return s >= 70 ? "var(--good)" : s >= 40 ? "var(--warn)" : "var(--fg-mute)";
}

function speakText(t: string) {
  try {
    const s = window.speechSynthesis;
    if (!s) return;
    s.cancel();
    const u = new SpeechSynthesisUtterance(t.slice(0, 500));
    u.rate = 1.05;
    s.speak(u);
  } catch { /* voice unavailable */ }
}

export default function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([
    { role: "assistant", content: "Hey! I'm the mehyar.jobs AI — ask me for jobs like \"remote Python roles\" or \"nursing jobs in Austin\" and I'll search our live database and score the matches. 📎 Attach your resume (or just upload the file) and I'll tune every score to your background. Tap 🎙️ to talk, 🔊 to hear my replies." },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [locked, setLocked] = useState<string | null>(null);
  const [resume, setResume] = useState(() => {
    try { return localStorage.getItem(LS_RESUME) || ""; } catch { return ""; }
  });
  const [showResume, setShowResume] = useState(false);
  const [draftResume, setDraftResume] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [speak, setSpeak] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recogRef = useRef<any>(null);
  const speakRef = useRef(false);

  useEffect(() => { speakRef.current = speak; }, [speak]);

  useEffect(() => {
    setVoiceSupported(
      typeof window !== "undefined" &&
      !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)
    );
    const openChat = () => setOpen(true);
    window.addEventListener("mhj:open-chat", openChat);
    return () => window.removeEventListener("mhj:open-chat", openChat);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, open]);

  function closeChat() {
    setOpen(false);
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
    if (listening) { try { recogRef.current?.stop(); } catch { /* ignore */ } setListening(false); }
  }

  function saveResume(text: string) {
    const t = text.slice(0, 12000);
    setResume(t);
    try {
      if (t.trim()) localStorage.setItem(LS_RESUME, t);
      else localStorage.removeItem(LS_RESUME);
    } catch { /* ignore */ }
    setShowResume(false);
    setParseErr(null);
  }

  async function onResumeFile(f: File | undefined) {
    if (!f || parsing) return;
    setParsing(true);
    setParseErr(null);
    try {
      const r: any = await api.parseResume(f);
      const text = String(r.text || "");
      if (text.trim().length < 200) {
        setParseErr("I couldn't pull enough text from that file — try pasting your resume instead.");
        return;
      }
      setDraftResume(text);
    } catch (e: any) {
      setParseErr(e?.body?.message || e?.message || "Couldn't read that file — try another one.");
    } finally {
      setParsing(false);
    }
  }

  function toggleListen() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    if (listening) {
      try { recogRef.current?.stop(); } catch { /* ignore */ }
      setListening(false);
      return;
    }
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e: any) => {
      const t = Array.from(e.results).map((r: any) => r[0]?.transcript || "").join(" ").trim();
      if (t) setInput((prev) => (prev ? prev + " " : "") + t);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recogRef.current = rec;
    try { rec.start(); setListening(true); } catch { setListening(false); }
  }

  async function send(text?: string) {
    const message = (text ?? input).trim();
    if (!message || busy || locked) return;
    setInput("");
    const next = [...msgs, { role: "user", content: message } as Msg];
    setMsgs(next);
    setBusy(true);
    try {
      const history = next.slice(-7, -1).map((m) => ({ role: m.role, content: m.content }));
      const r: any = await api.chat({
        message,
        history,
        resume_text: resume.trim().length >= 200 ? resume : undefined,
      });
      setRemaining(typeof r.chat_remaining === "number" ? r.chat_remaining : null);
      setMsgs([...next, { role: "assistant", content: r.reply, matches: r.matches || [], searched: r.searched, cta: r.cta }]);
      if (speakRef.current && r.reply) speakText(r.reply);
    } catch (e: any) {
      if (e?.body?.error === "chat_limit") {
        setLocked(e.body.message || "Daily chat limit reached.");
        setMsgs([...next, {
          role: "assistant",
          content: (e.body.message || "Daily chat limit reached.") + " I'm still here tomorrow — or keep exploring matches below.",
        } as Msg]);
      } else {
        setMsgs([...next, { role: "assistant", content: "Hmm, that hiccuped on my end — try again in a moment." } as Msg]);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {!open && (
        <button className="chat-fab" onClick={() => setOpen(true)} aria-label="Open job search chat" title="Ask the job AI">
          💬
        </button>
      )}
      {open && (
        <div className="chat-panel card">
          <div className="chat-head">
            <div>
              <div style={{ fontWeight: 800 }}>🤖 Job search AI</div>
              <div className="sm muted">
                {locked ? "daily limit reached" : remaining === null ? "searches live jobs · scores your fit" : `${remaining} chats left today`}
                {resume.trim().length >= 200 && !locked && " · 📎 resume on"}
              </div>
            </div>
            <div className="row" style={{ gap: 4 }}>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  const next = !speak;
                  setSpeak(next);
                  if (!next) { try { window.speechSynthesis?.cancel(); } catch { /* ignore */ } }
                  else speakText("Voice replies on. Ask me for jobs and I'll read the results.");
                }}
                aria-label={speak ? "Turn off voice replies" : "Turn on voice replies"}
                title={speak ? "Voice replies on — tap to mute" : "Hear my replies out loud"}
              >
                {speak ? "🔊" : "🔇"}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={closeChat} aria-label="Close chat">✕</button>
            </div>
          </div>

          <div className="chat-body">
            {msgs.map((m, i) => (
              <div key={i} className={`chat-msg ${m.role}`}>
                {m.role === "assistant" && <div className="chat-avatar">🤖</div>}
                <div className="chat-bubble-col">
                  <div className={`chat-bubble ${m.role}`}>{m.content}</div>
                  {m.role === "assistant" && m.cta && (
                    <Link href={m.cta.href} className="btn btn-primary btn-sm" style={{ marginTop: 8, textDecoration: "none", alignSelf: "flex-start" }}>{m.cta.label} →</Link>
                  )}
                  {m.role === "assistant" && m.searched && m.matches && m.matches.length > 0 && (
                    <div className="chat-matches">
                      {m.matches.map((j: any) => (
                        <div key={j.id} className="chat-match">
                          <span className="fit-chip" style={{ borderColor: scoreColor(j.score), color: scoreColor(j.score) }}>
                            {j.score}
                          </span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 700, fontSize: 13 }}>{j.title}</div>
                            <div className="sm muted" style={{ fontSize: 12 }}>
                              {j.company_name}
                              {j.location ? ` · ${j.location}` : ""}
                              {j.remote_policy === "remote" ? " · 🌐 remote" : ""}
                              {fmtSalary(j) ? ` · ${fmtSalary(j)}` : ""}
                            </div>
                          </div>
                          {j.url && (
                            <a href={j.url} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">Apply →</a>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {m.role === "assistant" && locked && (
                    <Link href={getToken() ? "/studio" : "/signup"}>
                      <button className="btn btn-primary btn-sm" style={{ marginTop: 8 }}>
                        {getToken() ? "Back tomorrow — open the studio →" : "Create a free account →"}
                      </button>
                    </Link>
                  )}
                </div>
              </div>
            ))}
            {busy && (
              <div className="chat-msg assistant">
                <div className="chat-avatar">🤖</div>
                <div className="chat-bubble assistant"><span className="typing"><i /><i /><i /></span></div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {!locked && msgs.length <= 2 && (
            <div className="chat-quick">
              {QUICK.map((q) => (
                <button key={q} className="chip" style={{ cursor: "pointer" }} onClick={() => send(q)}>{q}</button>
              ))}
              <Link href="/ats-mirror" className="chip" style={{ cursor: "pointer", textDecoration: "none", borderColor: "var(--accent)", color: "var(--accent)", fontWeight: 700 }}>🪞 ATS Mirror — audit my resume</Link>
            </div>
          )}

          <div className="chat-input-row">
            <button className="btn btn-ghost btn-sm" title={resume.trim() ? "Resume attached ✓ — click to change" : "Attach your resume"}
              onClick={() => { setDraftResume(resume); setParseErr(null); setShowResume(true); }}>
              {resume.trim().length >= 200 ? "📎✓" : "📎"}
            </button>
            {voiceSupported && (
              <button
                className="btn btn-ghost btn-sm"
                title={listening ? "Stop listening" : "Talk instead of typing"}
                aria-label={listening ? "Stop listening" : "Voice input"}
                onClick={toggleListen}
                style={listening ? { color: "#ef4444" } : undefined}
              >
                {listening ? "🔴" : "🎙️"}
              </button>
            )}
            <input
              className="input" placeholder={locked ? "Daily limit reached" : listening ? "Listening… speak now" : "Ask for jobs…"}
              value={input} disabled={busy || !!locked}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") send(); }}
            />
            <button className="btn btn-primary btn-sm" onClick={() => send()} disabled={busy || !!locked || !input.trim()}>
              {busy ? "…" : "Send"}
            </button>
          </div>

          {showResume && (
            <div className="chat-resume-modal">
              <div className="card" style={{ padding: 16, width: "100%" }}>
                <div style={{ fontWeight: 800, marginBottom: 8 }}>📎 Your resume</div>
                <p className="sm muted" style={{ margin: "0 0 8px" }}>
                  Upload your resume file or paste the text — I'll score every chat match against it.
                </p>
                <input
                  ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md" style={{ display: "none" }}
                  onChange={(e) => { onResumeFile(e.target.files?.[0]); e.target.value = ""; }}
                />
                <button className="btn" style={{ width: "100%", marginBottom: 8 }} disabled={parsing}
                  onClick={() => fileRef.current?.click()}>
                  {parsing ? "⏳ Reading your file…" : "📄 Upload PDF / DOCX / TXT"}
                </button>
                {parseErr && <p className="sm" style={{ color: "var(--bad)", margin: "0 0 8px" }}>{parseErr}</p>}
                <textarea className="input" rows={6} style={{ width: "100%", resize: "vertical" }}
                  placeholder="…or paste your resume text here"
                  value={draftResume} onChange={(e) => setDraftResume(e.target.value)} />
                <div className="row" style={{ gap: 8, marginTop: 10, justifyContent: "flex-end" }}>
                  {resume.trim() && (
                    <button className="btn btn-ghost btn-sm" onClick={() => saveResume("")}>Remove</button>
                  )}
                  <button className="btn btn-ghost btn-sm" onClick={() => setShowResume(false)}>Cancel</button>
                  <button className="btn btn-primary btn-sm" onClick={() => saveResume(draftResume)} disabled={parsing}>Save</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
