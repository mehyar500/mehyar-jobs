import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { api } from "../lib/api";
import { useToast } from "../lib/toast";

export default function Signup() {
  const toast = useToast();
  const [, navigate] = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [location, setLocation] = useState("");
  const [newsletter, setNewsletter] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refCode, setRefCode] = useState<string | null>(null);
  useEffect(() => {
    try { setRefCode(new URLSearchParams(window.location.search).get("ref")); } catch { /* ignore */ }
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Marketing consent is separate from account creation: signup works
    // with or without the newsletter checkbox.
    setBusy(true);
    try {
      await api.signup({ email, password, display_name: name, title, location, newsletter_opt_in: newsletter });
      // If they tapped "🔔 Alert me" before signing up, create that alert now.
      let pending: any = null;
      try { pending = JSON.parse(localStorage.getItem("pending_alert") || "null"); } catch { /* ignore */ }
      if (pending && Object.keys(pending).length) {
        try {
          await api.createAlert(pending);
          try { localStorage.removeItem("pending_alert"); } catch { /* ignore */ }
          toast.push({ kind: "success", title: "🔔 Alert on", message: "We'll email you when new jobs match your search." });
        } catch {
          toast.push({ kind: "error", title: "Alert not saved", message: "Your alert is still pending — tap 🔔 Alert me again from the job browser and we'll set it up." });
        }
      }
      toast.push({ kind: "success", title: "Welcome aboard 🎉", message: "Now upload your resume to get your matches." });
      navigate("/run");
    } catch (e: any) {
      toast.push({ kind: "error", title: "Signup failed", message: e.body?.error || e.message });
    } finally { setBusy(false); }
  }

  return (
    <div className="col" style={{ gap: 16, maxWidth: 520, margin: "0 auto", paddingBottom: 48 }}>
      <div className="card">
        <h1 className="h1">✨ Create your free account</h1>
        <p className="sm muted" style={{ marginTop: 4 }}>
          Browsing is free for everyone. Create an account to run the board against your resume and get daily email matches. The newsletter below is optional — you can join or leave it any time from your account.
        </p>
        {refCode && (
          <div className="card card-tight" style={{ marginTop: 12, border: "1px dashed var(--good)" }}>
            🎁 <strong>You were invited!</strong> <span className="sm">You and your friend each get <strong>+10 bonus AI chats</strong> when you join.</span>
          </div>
        )}
      </div>
      <form className="card col" style={{ gap: 12 }} onSubmit={submit}>
        <label className="col" style={{ gap: 4 }}>
          <span className="sm" style={{ fontWeight: 600 }}>Email</span>
          <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        </label>
        <label className="col" style={{ gap: 4 }}>
          <span className="sm" style={{ fontWeight: 600 }}>Password (8+ characters)</span>
          <input className="input" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        </label>
        <label className="col" style={{ gap: 4 }}>
          <span className="sm" style={{ fontWeight: 600 }}>Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" />
        </label>
        <label className="col" style={{ gap: 4 }}>
          <span className="sm" style={{ fontWeight: 600 }}>Current / target title</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Registered Nurse, Product Designer…" />
        </label>
        <label className="col" style={{ gap: 4 }}>
          <span className="sm" style={{ fontWeight: 600 }}>Location</span>
          <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="New York, NY" />
        </label>
        <label className="row" style={{ gap: 10, alignItems: "flex-start", cursor: "pointer", background: "var(--card)", padding: 12, borderRadius: 8, border: "1px solid var(--border)" }}>
          <input type="checkbox" checked={newsletter} onChange={(e) => setNewsletter(e.target.checked)} style={{ marginTop: 4, width: 18, height: 18 }} />
          <span className="sm">
            <strong>Optional: join the daily jobs newsletter</strong> — a short email every morning with your new matches. Not required for your account or resume runs; join later any time from your account settings. Unsubscribe in one click.
          </span>
        </label>
        <button className="btn btn-primary" style={{ padding: 12, fontSize: 16 }} disabled={busy}>
          {busy ? "Creating account…" : "Create account & continue →"}
        </button>
        <p className="sm muted" style={{ textAlign: "center" }}>
          Already have an account? <Link href="/login"><strong>Log in</strong></Link>
        </p>
      </form>
    </div>
  );
}
