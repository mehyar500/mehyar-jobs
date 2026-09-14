import { useState } from "react";
import { api } from "../lib/api";

export default function Advertise() {
  const [form, setForm] = useState({ company_name: "", contact_email: "", job_title: "", job_url: "", message: "" });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r: any = await api.requestFeatured(form);
      if (r?.ok) setDone(true);
      else setErr(r?.message || "Something went wrong — try again.");
    } catch (e: any) {
      setErr(e?.message || "Something went wrong — try again.");
    } finally { setBusy(false); }
  }

  const field = (k: keyof typeof form, label: string, type = "text", ph = "") => (
    <label style={{ display: "block", marginBottom: 12 }}>
      <div className="sm" style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <input className="input" type={type} value={form[k]} placeholder={ph}
        onChange={(e) => setForm({ ...form, [k]: e.target.value })} style={{ width: "100%" }} required={k === "company_name" || k === "contact_email"} />
    </label>
  );

  return (
    <div className="col" style={{ gap: 16, maxWidth: 640, margin: "0 auto", paddingBottom: 48 }}>
      <div className="card" style={{ textAlign: "center", padding: 32 }}>
        <div style={{ fontSize: 40 }}>⭐</div>
        <h1 className="h1" style={{ marginTop: 8 }}>Put your job in front of matched candidates</h1>
        <p className="muted" style={{ marginTop: 8 }}>
          A <strong>Featured listing</strong> pins your role to the top of every matching candidate's feed
          with a ⭐ Featured badge — plus optional placement in our daily job emails.
        </p>
        <div className="row" style={{ gap: 12, justifyContent: "center", marginTop: 16, flexWrap: "wrap" }}>
          <div className="card card-tight"><div className="h2">$49</div><div className="xs muted">7 days featured</div></div>
          <div className="card card-tight"><div className="h2">$99</div><div className="xs muted">30 days + email slot</div></div>
        </div>
        <p className="xs muted" style={{ marginTop: 12 }}>Job seekers always browse free — employers keep it that way.</p>
      </div>

      <div className="card">
        {done ? (
          <div style={{ textAlign: "center", padding: 24 }}>
            <div style={{ fontSize: 40 }}>✅</div>
            <h2 className="h2" style={{ marginTop: 8 }}>Request received</h2>
            <p className="sm muted">We'll reply within one business day with payment + go-live details.</p>
          </div>
        ) : (
          <form onSubmit={submit}>
            <h2 className="h2" style={{ marginBottom: 12 }}>Request a featured listing</h2>
            {field("company_name", "Company name *", "text", "Acme Corp")}
            {field("contact_email", "Work email *", "email", "hiring@acme.com")}
            {field("job_title", "Job title", "text", "Senior Backend Engineer")}
            {field("job_url", "Link to the live posting", "url", "https://…")}
            <label style={{ display: "block", marginBottom: 12 }}>
              <div className="sm" style={{ fontWeight: 600, marginBottom: 4 }}>Anything we should know?</div>
              <textarea value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })}
                placeholder="Hiring timeline, must-have skills…" rows={3} style={{ width: "100%" }} />
            </label>
            {err && <div className="tag tag-red" style={{ marginBottom: 12 }}>{err}</div>}
            <button className="btn btn-primary" disabled={busy} style={{ width: "100%" }}>
              {busy ? "Sending…" : "Request featured listing →"}
            </button>
            <p className="xs muted" style={{ marginTop: 8, textAlign: "center" }}>
              No payment today — we confirm availability and send a payment link by email.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
