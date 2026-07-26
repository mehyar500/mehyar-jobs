import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

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
};

export default function Profile() {
  const qc = useQueryClient();
  const pQ = useQuery({ queryKey: ["profile"], queryFn: () => api.profile() });

  const [form, setForm] = useState<any>(DEFAULTS);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<number | null>(null);

  useEffect(() => {
    const p = pQ.data?.profile;
    if (p) setForm({
      target_titles: p.target_titles || [],
      keywords: p.keywords || [],
      exclude_keywords: p.exclude_keywords || [],
      locations: p.locations || [],
      remote_required: p.remote_required || false,
      min_salary_usd: p.min_salary_usd || null,
      preferred_industries: p.preferred_industries || [],
      excluded_industries: p.excluded_industries || [],
      notes: p.notes || "",
    });
  }, [pQ.data]);

  const save = async () => {
    setSaving(true);
    setSaved(null);
    try {
      await api.saveProfile(form);
      await api.triggerScore();
      setSaved(Date.now());
      qc.invalidateQueries({ queryKey: ["profile"] });
      qc.invalidateQueries({ queryKey: ["jobs"] });
    } catch (e) { console.error(e); }
    finally { setSaving(false); }
  };

  const update = (k: string, v: any) => setForm({ ...form, [k]: v });
  const arrayToStr = (a: string[]) => (a || []).join(", ");
  const strToArray = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

  return (
    <div className="col" style={{ gap: 16, maxWidth: 760 }}>
      <div className="card">
        <h1 className="h1">🪪 Your profile</h1>
        <p className="sm muted" style={{ marginTop: 4 }}>
          Fit score is calculated from these fields against every job.
          Saving re-scores every active job instantly.
        </p>
      </div>

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
        <input type="checkbox" checked={form.remote_required} onChange={(e) => update("remote_required", e.target.checked)} style={{ width: 18, height: 18 }} />
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
        <div className="h3">Notes</div>
        <textarea rows={3} placeholder="Anything else that should affect scoring…" value={form.notes} onChange={(e) => update("notes", e.target.value)} />
      </div>

      <div className="row">
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? "saving + rescoring…" : "Save profile + rescore all jobs"}
        </button>
        {saved ? <span className="tag tag-emerald">saved · rescoring…</span> : null}
      </div>
    </div>
  );
}

function Field({ title, sub, value, onChange, placeholder }: any) { // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (
    <div className="card">
      <div className="h3">{title}</div>
      <div className="xs dim" style={{ marginBottom: 8 }}>{sub}</div>
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  );
}