import { useState } from "react";

export default function RecruiterMatch() {
  const [form, setForm] = useState({ name: "", email: "", phone: "", title: "", skills: "", location: "", remote_ok: false, consent: false });
  const [status, setStatus] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus("sending"); setMsg("");
    try {
      const params = new URLSearchParams(window.location.search);
      const r = await fetch("/api/public/recruiter-lead", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...form,
          skills: form.skills.split(",").map((s) => s.trim()).filter(Boolean),
          contact_id: params.get("c") ? Number(params.get("c")) : null,
        }),
      });
      const d = (await r.json()) as { ok?: boolean; error?: string; lead_id?: number };
      if (d.ok) { setStatus("done"); }
      else { setStatus("error"); setMsg(d.error === "consent_required" ? "Please check the consent box to continue." : "Something went wrong — try again."); }
    } catch { setStatus("error"); setMsg("Network hiccup — try again."); }
  };

  if (status === "done") return (
    <div className="card" style={{ textAlign: "center", padding: 40 }}>
      <h1>✅ You're on the list</h1>
      <p className="muted">Vetted recruiters will reach out when a role fits your profile. You can withdraw anytime from the unsubscribe page.</p>
      <a className="btn" href="/">Browse jobs →</a>
    </div>
  );

  const inp = { width: "100%", padding: 10, border: "1px solid #ddd", borderRadius: 8, marginTop: 4 } as const;
  return (
    <div className="card" style={{ maxWidth: 560, margin: "24px auto" }}>
      <h1 style={{ marginTop: 0 }}>💼 Get matched with recruiters</h1>
      <p className="muted">One opt-in. Vetted recruiters see your profile and reach out about roles that fit. Free forever — recruiters pay, you don't.</p>
      <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
        <label>Name<input style={inp} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Jane Doe" /></label>
        <label>Email<input style={inp} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="you@email.com" /></label>
        <label>Phone (optional)<input style={inp} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+1…" /></label>
        <label>Current / target title<input style={inp} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Senior Backend Engineer" /></label>
        <label>Top skills (comma separated)<input style={inp} value={form.skills} onChange={(e) => setForm({ ...form, skills: e.target.value })} placeholder="Python, AWS, Postgres" /></label>
        <label>Location<input style={inp} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="New York, NY" /></label>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={form.remote_ok} onChange={(e) => setForm({ ...form, remote_ok: e.target.checked })} /> Open to remote
        </label>
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
          <input type="checkbox" checked={form.consent} onChange={(e) => setForm({ ...form, consent: e.target.checked })} required />
          <span>I agree that mehyar.jobs may share my profile (name, title, skills, location) with vetted recruiters and employers for job matching. I can withdraw anytime via the unsubscribe page.</span>
        </label>
        {msg && <p className="muted">{msg}</p>}
        <button className="btn" disabled={status === "sending"}>{status === "sending" ? "Saving…" : "Match me with recruiters →"}</button>
      </form>
    </div>
  );
}
