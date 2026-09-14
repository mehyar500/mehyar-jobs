import { useEffect, useState } from "react";
import { Link } from "wouter";
import { api, getToken } from "../lib/api";

function scoreColor(s: number) {
  if (s >= 75) return "var(--good)";
  if (s >= 55) return "var(--warn)";
  return "var(--bad)";
}

function ScoreRing({ score }: { score: number }) {
  const r = 54;
  const c = 2 * Math.PI * r;
  const color = scoreColor(score);
  return (
    <div className="score-ring">
      <svg width="132" height="132" viewBox="0 0 132 132">
        <circle cx="66" cy="66" r={r} fill="none" stroke="var(--border)" strokeWidth="11" />
        <circle cx="66" cy="66" r={r} fill="none" stroke={color} strokeWidth="11" strokeLinecap="round"
          strokeDasharray={`${(score / 100) * c} ${c}`} />
      </svg>
      <div className="score-num">
        <span style={{ fontSize: 34, fontWeight: 800 }}>{score}</span>
        <span className="sm muted">/ 100</span>
      </div>
    </div>
  );
}

function Section({ title, icon, items, empty }: { title: string; icon: string; items: string[]; empty: string }) {
  return (
    <div className="card card-tight">
      <h3 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 6px" }}>{icon} {title}</h3>
      {items?.length ? (
        <ul className="review-list">{items.map((x, i) => <li key={i}>{x}</li>)}</ul>
      ) : (
        <p className="sm muted" style={{ margin: 0 }}>{empty}</p>
      )}
    </div>
  );
}

// Single partner offer card — exactly one offer per touchpoint.
function OfferCard({ label, title, body, cta, href }: { label: string; title: string; body: string; cta: string; href: string }) {
  return (
    <div className="card card-tight" style={{ border: "1px solid var(--warn)", background: "var(--card)" }}>
      <div className="xs" style={{ fontWeight: 800, letterSpacing: ".08em", color: "var(--warn)" }}>{label}</div>
      <div style={{ fontWeight: 700, margin: "6px 0 2px" }}>{title}</div>
      <p className="sm muted" style={{ margin: "0 0 10px" }}>{body}</p>
      <a href={href}><button className="btn btn-primary btn-sm">{cta} →</button></a>
    </div>
  );
}

export default function Review() {
  const loggedIn = !!getToken();
  const [me, setMe] = useState<any>(null);
  const [review, setReview] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [roastUrl, setRoastUrl] = useState<string | null>(null);
  const [roastBusy, setRoastBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!loggedIn) return;
    api.me().then((m: any) => {
      setMe(m);
      if (m?.user?.llm_review) setReview(m.user.llm_review);
    }).catch(() => {});
  }, [loggedIn]);

  async function runReview() {
    setBusy(true);
    setErr(null);
    try {
      const r: any = await api.reviewResume();
      setReview(r.review);
    } catch (e: any) {
      setErr(e?.message || "review failed");
    } finally {
      setBusy(false);
    }
  }

  if (!loggedIn) {
    return (
      <div className="container" style={{ padding: "48px 16px", maxWidth: 560 }}>
        <div className="card" style={{ textAlign: "center", padding: 40 }}>
          <div style={{ fontSize: 44 }}>🤖</div>
          <h1 className="h1" style={{ marginTop: 8 }}>AI resume review</h1>
          <p className="sm muted">Our AI reads your resume the way a hiring manager would and scores it 0–100 — with honest strengths, gaps, and fixes.</p>
          <div className="row" style={{ gap: 8, justifyContent: "center", marginTop: 16 }}>
            <Link href="/signup"><button className="btn btn-primary">Sign up free</button></Link>
            <Link href="/login"><button className="btn btn-ghost">Log in</button></Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="col" style={{ gap: 20, paddingBottom: 48 }}>
      <section className="card" style={{ padding: 28 }}>
        <div className="row" style={{ gap: 20, flexWrap: "wrap", alignItems: "center" }}>
          {review ? (
            <ScoreRing score={review.score} />
          ) : (
            <div style={{ fontSize: 56 }}>🤖</div>
          )}
          <div className="col" style={{ gap: 8, flex: "1 1 280px" }}>
            <h1 className="h1" style={{ margin: 0 }}>AI resume review</h1>
            <p className="sm muted" style={{ margin: 0 }}>
              {me?.user?.has_resume
                ? `Scored against your saved resume${me.user.resume_filename ? ` (${me.user.resume_filename})` : ""} — the same 0–100 scale our job-fit engine uses.`
                : "Upload a resume first, then let the AI score it like a hiring manager would."}
            </p>
            {review?.verdict && <p style={{ margin: 0, fontSize: 15 }}><em>“{review.verdict}”</em></p>}
            <div className="row" style={{ gap: 8, marginTop: 4 }}>
              {me?.user?.has_resume ? (
                <button className="btn btn-primary" onClick={runReview} disabled={busy}>
                  {busy ? "Reading your resume…" : review ? "↻ Re-run AI review" : "✨ Get my AI review"}
                </button>
              ) : (
                <Link href="/run"><button className="btn btn-primary">Upload my resume →</button></Link>
              )}
            </div>
            {err && <div className="tag tag-red">{err}</div>}
            {busy && <p className="sm muted" style={{ margin: 0 }}>The AI is reading every line… usually under 30 seconds.</p>}
          </div>
        </div>
      </section>

      {review && (
        <div className="col" style={{ gap: 12 }}>
          {/* Score-reveal moment: exactly one offer — resume help when the score says it's needed. */}
          {review.score < 75 && (
            <OfferCard
              label="SPONSORED · PARTNER PICK"
              title="Your resume is holding you back — fix it in 15 minutes"
              body="MyPerfectResume's guided builder uses recruiter-approved templates and pre-written bullets. The fastest upgrade for a sub-75 score."
              cta="Build my resume"
              href="/go/myperfectresume"
            />
          )}
          <div className="steps" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
            <Section title="Strengths" icon="💪" items={review.strengths} empty="No strengths listed." />
            <Section title="Gaps to fix" icon="🕳️" items={review.gaps} empty="No gaps listed." />
          </div>
          {/* Skill-gap display: exactly one offer — courses matched to the gaps. */}
          {(review.gaps?.length > 0 || review.missing_keywords?.length > 0) && (
            <OfferCard
              label="SPONSORED · PARTNER PICK"
              title="Close the gap with a career certificate"
              body="Coursera's Google & Meta certificates teach the exact skills your review flagged — and hiring managers respect them."
              cta="Browse certificates"
              href="/go/coursera"
            />
          )}
          <div className="steps" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
            <Section title="Missing keywords" icon="🔑" items={review.missing_keywords} empty="None flagged." />
            <Section title="Titles you fit" icon="🎯" items={review.suggested_titles} empty="None suggested." />
            <Section title="Quick improvements" icon="🛠️" items={review.improvements} empty="None suggested." />
          </div>
          <div className="card card-tight" style={{ textAlign: "center" }}>
            <div style={{ fontWeight: 700 }}>🔥 Share your roast</div>
            <p className="sm muted" style={{ margin: "4px 0 12px" }}>
              Get a public link with your score card — anonymous, no name or contact info attached.
            </p>
            {!roastUrl ? (
              <button className="btn" onClick={async () => {
                setRoastBusy(true);
                try {
                  const r: any = await api.createRoast();
                  setRoastUrl(r.url);
                } catch (e: any) { setErr(e?.message || "roast failed"); }
                finally { setRoastBusy(false); }
              }} disabled={roastBusy}>{roastBusy ? "Minting…" : "🔥 Create share link"}</button>
            ) : (
              <div className="row" style={{ gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
                <input className="input" readOnly value={roastUrl} style={{ maxWidth: 320 }} onFocus={(e) => e.target.select()} />
                <button className="btn btn-primary btn-sm" onClick={() => {
                  navigator.clipboard?.writeText(roastUrl).catch(() => {});
                  setCopied(true); setTimeout(() => setCopied(false), 2000);
                }}>{copied ? "✓ Copied" : "Copy link"}</button>
                <a href={roastUrl} target="_blank" rel="noreferrer"><button className="btn btn-ghost btn-sm">Preview →</button></a>
              </div>
            )}
          </div>
          <p className="sm muted" style={{ textAlign: "center" }}>
            This review is saved on your resume — run it again any time after you update it.
          </p>
        </div>
      )}

      {!review && me?.user?.has_resume && (
        <div className="card card-tight muted" style={{ textAlign: "center" }}>
          No review yet. Hit <strong>Get my AI review</strong> above — it takes about 20 seconds.
        </div>
      )}
    </div>
  );
}
