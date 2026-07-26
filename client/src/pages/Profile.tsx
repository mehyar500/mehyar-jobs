import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useToast } from "../lib/toast";

const DEFAULTS = {
  target_titles: ["AI Engineer", "Staff Engineer", "Founding Engineer", "ML Engineer", "Engineering Manager", "Product Manager"],
  keywords: ["llm", "rag", "agent", "ai", "ml", "agentic", "langchain", "vector", "evals", "prompt", "fine-tuning", "gpt", "claude", "openai", "anthropic"],
  exclude_keywords: ["clearance required", "phd required", "on-site only", "5 days a week"],
  locations: ["Remote", "NYC", "New York", "San Francisco", "London", "Berlin"],
  remote_required: false,
  min_salary_usd: 200000,
  preferred_industries: ["ai", "fintech", "tech"],
  excluded_industries: ["tobacco", "weapons"],
  notes: "",
  // extended
  full_name: "Mehyar Swelim ", 
  email: "",
  phone: "",
  city: "",
  country: "",
  linkedin_url: "",
  github_url: "",
  portfolio_url: "",
  personal_website: "",
  resume_filename: "",
  resume_mime: "",
  resume_base64: "",
  resume_text: "",
  years_experience: null,
  current_title: "",
  current_company: "",
  current_salary: null,
  notice_period: "",
  work_auth: "",
  gender: "",
  ethnicity: "",
  veteran_status: "",
  disability: "",
  hispanic_latino: "",
  cleartext_address: "",
  default_answers: {},
};

export default function Profile() {
  const qc = useQueryClient();
  const toast = useToast();
  const pQ = useQuery({ queryKey: ["profile"], queryFn: () => api.profile() });

  const [form, setForm] = useState<any>(DEFAULTS);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const p = pQ.data?.profile;
    if (p) setForm({ ...DEFAULTS, ...p });
  }, [pQ.data]);

  const save = async () => {
    setSaving(true);
    try {
      await api.saveProfile(form);
      await api.triggerScore();
      qc.invalidateQueries({ queryKey: ["profile"] });
      qc.invalidateQueries({ queryKey: ["jobs"] });
      toast.push({ kind: "success", title: "Profile saved", message: "All 2,583 jobs re-scored against your updated profile." });
    } catch (e: any) {
      toast.push({ kind: "error", title: "Save failed", message: e?.body?.error || e?.message });
    } finally {
      setSaving(false);
    }
  };

  const update = (k: string, v: any) => setForm({ ...form, [k]: v });
  const arrayToStr = (a: string[]) => (a || []).join(", ");
  const strToArray = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

  const onResume = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 3_000_000) {
      toast.push({ kind: "error", title: "File too large", message: "Resume must be under 3MB." });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1] || "";
      update("resume_filename", f.name);
      update("resume_mime", f.type || "application/pdf");
      update("resume_base64", base64);
      toast.push({ kind: "success", title: "Resume loaded", message: `${f.name} (${(f.size / 1024).toFixed(0)}KB) — click Save to upload.` });
    };
    reader.readAsDataURL(f);
  };

  return (
    <div className="col" style={{ gap: 16, maxWidth: 760 }}>
      <div className="card">
        <h1 className="h1">🪪 Your profile</h1>
        <p className="sm muted" style={{ marginTop: 4 }}>
          Fit score is calculated from these fields against every job. Saving re-scores every active job instantly.
        </p>
      </div>

      <Section title="👤 Personal" sub="Used to pre-fill the application form when auto-submitting.">
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <SimpleField label="Full name" value={form.full_name} onChange={(v) => update("full_name", v)} />
          <SimpleField label="Email" type="email" value={form.email} onChange={(v) => update("email", v)} />
          <SimpleField label="Phone" value={form.phone} onChange={(v) => update("phone", v)} />
          <SimpleField label="City" value={form.city} onChange={(v) => update("city", v)} />
          <SimpleField label="Country" value={form.country} onChange={(v) => update("country", v)} />
          <SimpleField label="Notice period" value={form.notice_period} onChange={(v) => update("notice_period", v)} placeholder="2 weeks" />
        </div>
      </Section>

      <Section title="📄 Resume" sub="The PDF/DOCX is uploaded to every company form. The text version is what the LLM uses to answer free-form questions.">
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <label className="btn btn-primary" style={{ cursor: "pointer" }}>
            📎 {form.resume_filename ? "Replace resume" : "Upload resume (PDF / DOCX)"}
            <input type="file" accept="application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={onResume} style={{ display: "none" }} />
          </label>
          {form.resume_filename ? (
            <>
              <span className="tag tag-emerald">✓ {form.resume_filename}</span>
              <button className="btn btn-ghost btn-sm" onClick={() => { update("resume_filename", ""); update("resume_mime", ""); update("resume_base64", ""); }}>Remove</button>
            </>
          ) : null}
        </div>
        <div style={{ marginTop: 10 }}>
          <div className="xs dim" style={{ marginBottom: 4 }}>Plain-text version (used by the LLM when filling free-form questions):</div>
          <textarea rows={6} placeholder="Paste your resume as plain text here, or upload the PDF above and we'll extract it…" value={form.resume_text} onChange={(e) => update("resume_text", e.target.value)} />
        </div>
      </Section>

      <Section title="🔗 Links" sub="Filled into 'LinkedIn URL', 'GitHub', 'Portfolio' fields on the company form.">
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <SimpleField label="LinkedIn" value={form.linkedin_url} onChange={(v) => update("linkedin_url", v)} placeholder="https://linkedin.com/in/…" />
          <SimpleField label="GitHub" value={form.github_url} onChange={(v) => update("github_url", v)} placeholder="https://github.com/…" />
          <SimpleField label="Portfolio" value={form.portfolio_url} onChange={(v) => update("portfolio_url", v)} placeholder="https://yoursite.com" />
          <SimpleField label="Personal website" value={form.personal_website} onChange={(v) => update("personal_website", v)} />
        </div>
      </Section>

      <Section title="💼 Current role" sub="Filled into 'Current/Most Recent Title', 'Current Employer', 'Years of Experience' fields.">
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <SimpleField label="Current title" value={form.current_title} onChange={(v) => update("current_title", v)} placeholder="Senior Software Engineer" />
          <SimpleField label="Current company" value={form.current_company} onChange={(v) => update("current_company", v)} />
          <SimpleField label="Years of experience" type="number" value={form.years_experience || ""} onChange={(v) => update("years_experience", v ? parseInt(v, 10) : null)} />
          <SimpleField label="Current salary (USD)" type="number" value={form.current_salary || ""} onChange={(v) => update("current_salary", v ? parseInt(v, 10) : null)} />
        </div>
      </Section>

      <Section title="📋 Job preferences" sub="Used to compute fit score.">
        <Field
          title="Target titles"
          sub="What roles you want. Synonyms are expanded automatically (e.g. 'Staff Engineer' matches 'Principal Engineer')."
          value={arrayToStr(form.target_titles)}
          onChange={(v: string) => update("target_titles", strToArray(v))}
          placeholder="AI Engineer, Staff Engineer, Founding Engineer…"
        />
        <Field
          title="Keywords"
          sub="Phrases in the description that should boost your fit (LLM, agent, RAG, …)."
          value={arrayToStr(form.keywords)}
          onChange={(v: string) => update("keywords", strToArray(v))}
          placeholder="llm, rag, agent, vector, prompt…"
        />
        <Field
          title="Exclude keywords"
          sub="If these appear in the title or description, the job is hard-no'd (filtered out)."
          value={arrayToStr(form.exclude_keywords)}
          onChange={(v: string) => update("exclude_keywords", strToArray(v))}
          placeholder="clearance required, phd required…"
        />
        <Field
          title="Locations"
          sub="Locations you accept. Use 'Remote' to match all remote jobs."
          value={arrayToStr(form.locations)}
          onChange={(v: string) => update("locations", strToArray(v))}
          placeholder="Remote, NYC, London…"
        />
        <label className="card row" style={{ justifyContent: "space-between" }}>
          <div>
            <div className="h3">Remote required</div>
            <div className="xs dim">Hide hybrid & on-site jobs from your results.</div>
          </div>
          <input type="checkbox" checked={!!form.remote_required} onChange={(e) => update("remote_required", e.target.checked)} style={{ width: 18, height: 18 }} />
        </label>
        <div className="card">
          <div className="h3">Min salary (USD)</div>
          <div className="xs dim" style={{ marginBottom: 8 }}>Jobs below 85% of this are filtered out.</div>
          <input type="number" min="0" step="5000" value={form.min_salary_usd || ""} onChange={(e) => update("min_salary_usd", e.target.value ? parseInt(e.target.value, 10) : null)} />
        </div>
        <Field
          title="Preferred industries"
          sub="Industries that boost your fit (+5)."
          value={arrayToStr(form.preferred_industries)}
          onChange={(v: string) => update("preferred_industries", strToArray(v))}
          placeholder="ai, fintech, healthtech…"
        />
        <Field
          title="Excluded industries"
          sub="Industries where any job is hard-no'd."
          value={arrayToStr(form.excluded_industries)}
          onChange={(v: string) => update("excluded_industries", strToArray(v))}
          placeholder="tobacco, weapons…"
        />
        <div className="card">
          <div className="h3">Work authorization</div>
          <select value={form.work_auth || ""} onChange={(e) => update("work_auth", e.target.value)}>
            <option value="">— select —</option>
            <option value="US Citizen">US Citizen</option>
            <option value="Green Card holder">Green Card holder</option>
            <option value="H1B visa">H1B visa</option>
            <option value="Authorized to work in the US, no sponsorship needed">Authorized to work in the US, no sponsorship needed</option>
            <option value="Need visa sponsorship">Need visa sponsorship</option>
            <option value="Authorized to work in the EU">Authorized to work in the EU</option>
            <option value="Authorized to work in the UK">Authorized to work in the UK</option>
            <option value="Other">Other (specify in notes)</option>
          </select>
        </div>
        <div className="card">
          <div className="h3">Notes (private)</div>
          <textarea rows={3} placeholder="Anything else that should affect scoring…" value={form.notes || ""} onChange={(e) => update("notes", e.target.value)} />
        </div>
      </Section>

      <Section title="🏛️ EEO voluntary self-identification" sub="Used to fill the optional demographic questions on US job applications. Most companies let you select 'Prefer not to say'.">
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <div>
            <div className="xs dim" style={{ marginBottom: 4 }}>Gender</div>
            <select value={form.gender || ""} onChange={(e) => update("gender", e.target.value)}>
              <option value="">— select —</option>
              <option value="Male">Male</option>
              <option value="Female">Female</option>
              <option value="Non-binary">Non-binary</option>
              <option value="Prefer not to say">Prefer not to say</option>
            </select>
          </div>
          <div>
            <div className="xs dim" style={{ marginBottom: 4 }}>Hispanic / Latino</div>
            <select value={form.hispanic_latino || ""} onChange={(e) => update("hispanic_latino", e.target.value)}>
              <option value="">— select —</option>
              <option value="Yes">Yes</option>
              <option value="No">No</option>
              <option value="Prefer not to say">Prefer not to say</option>
            </select>
          </div>
          <div>
            <div className="xs dim" style={{ marginBottom: 4 }}>Ethnicity / Race</div>
            <select value={form.ethnicity || ""} onChange={(e) => update("ethnicity", e.target.value)}>
              <option value="">— select —</option>
              <option value="White">White</option>
              <option value="Black or African American">Black or African American</option>
              <option value="Asian">Asian</option>
              <option value="Native Hawaiian or Other Pacific Islander">Native Hawaiian or Other Pacific Islander</option>
              <option value="American Indian or Alaska Native">American Indian or Alaska Native</option>
              <option value="Two or More Races">Two or More Races</option>
              <option value="Prefer not to say">Prefer not to say</option>
            </select>
          </div>
          <div>
            <div className="xs dim" style={{ marginBottom: 4 }}>Veteran status</div>
            <select value={form.veteran_status || ""} onChange={(e) => update("veteran_status", e.target.value)}>
              <option value="">— select —</option>
              <option value="Yes">Yes</option>
              <option value="No">No</option>
              <option value="Prefer not to say">Prefer not to say</option>
            </select>
          </div>
          <div>
            <div className="xs dim" style={{ marginBottom: 4 }}>Disability status</div>
            <select value={form.disability || ""} onChange={(e) => update("disability", e.target.value)}>
              <option value="">— select —</option>
              <option value="Yes">Yes, I have a disability</option>
              <option value="No">No, I don't have a disability</option>
              <option value="Prefer not to say">Prefer not to say</option>
            </select>
          </div>
        </div>
      </Section>

      <div className="row" style={{ position: "sticky", bottom: 12, padding: "12px 0", background: "var(--bg)" }}>
        <button className="btn btn-primary" onClick={save} disabled={saving} data-testid="save-profile-btn">
          {saving ? <><span className="spinner" /> saving + rescoring…</> : "Save profile + rescore all jobs"}
        </button>
      </div>
    </div>
  );
}

function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <h2 className="h2">{title}</h2>
      {sub ? <p className="sm muted" style={{ marginTop: 4 }}>{sub}</p> : null}
      <div className="col" style={{ gap: 10, marginTop: 12 }}>{children}</div>
    </div>
  );
}

function Field({ title, sub, value, onChange, placeholder }: { title: string; sub?: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <div>
      <div className="h3">{title}</div>
      {sub ? <div className="xs dim" style={{ marginBottom: 6 }}>{sub}</div> : null}
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  );
}

function SimpleField({ label, value, onChange, placeholder, type }: { label: string; value: string | number | null | undefined; onChange: (value: string) => void; placeholder?: string; type?: string }) {
  return (
    <div>
      <div className="xs dim" style={{ marginBottom: 4 }}>{label}</div>
      <input type={type || "text"} value={value || ""} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  );
}
