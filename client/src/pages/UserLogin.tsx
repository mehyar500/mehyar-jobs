import { useState } from "react";
import { Link, useLocation } from "wouter";
import { api } from "../lib/api";
import { useToast } from "../lib/toast";

export default function UserLogin() {
  const toast = useToast();
  const [, navigate] = useLocation();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.userLogin(identifier, password);
      toast.push({ kind: "success", title: "Welcome back 👋" });
      navigate("/run");
    } catch (e: any) {
      toast.push({ kind: "error", title: "Login failed", message: e.body?.error || e.message });
    } finally { setBusy(false); }
  }

  return (
    <div className="col" style={{ gap: 16, maxWidth: 440, margin: "0 auto", paddingBottom: 48 }}>
      <div className="card">
        <h1 className="h1">👋 Log in</h1>
        <p className="sm muted" style={{ marginTop: 4 }}>Pick up where you left off — your resume, matches, and newsletter settings are saved.</p>
      </div>
      <form className="card col" style={{ gap: 12 }} onSubmit={submit}>
        <label className="col" style={{ gap: 4 }}>
          <span className="sm" style={{ fontWeight: 600 }}>Email or username</span>
          <input className="input" required value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="you@example.com" />
        </label>
        <label className="col" style={{ gap: 4 }}>
          <span className="sm" style={{ fontWeight: 600 }}>Password</span>
          <input className="input" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        </label>
        <button className="btn btn-primary" style={{ padding: 12, fontSize: 16 }} disabled={busy}>
          {busy ? "Logging in…" : "Log in →"}
        </button>
        <p className="sm muted" style={{ textAlign: "center" }}>
          New here? <Link href="/signup"><strong>Create a free account</strong></Link>
        </p>
      </form>
    </div>
  );
}
