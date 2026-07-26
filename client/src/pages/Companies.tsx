import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

export default function Companies() {
  const [q, setQ] = useState("");
  const [industry, setIndustry] = useState("");
  const [status, setStatus] = useState("");
  const params = useMemo(() => {
    const p: any = {};
    if (q) p.q = q;
    if (industry) p.industry = industry;
    if (status) p.scrape_status = status;
    return p;
  }, [q, industry, status]);
  const cQ = useQuery({ queryKey: ["companies", params], queryFn: () => api.companies(params) });
  const items: any[] = cQ.data?.items || [];
  const facets: any[] = cQ.data?.facets || [];

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card">
        <h1 className="h1">🏢 Companies we track</h1>
        <p className="sm muted" style={{ marginTop: 4 }}>
          {cQ.data?.total ?? 0} companies · {items.filter((c: any) => c.scrape_status === "ok").length} scraping cleanly
        </p>
      </div>
      <div className="card">
        <div className="grid" style={{ gridTemplateColumns: "2fr 1fr 1fr" }}>
          <input type="search" placeholder="Search company / slug / careers URL…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={industry} onChange={(e) => setIndustry(e.target.value)}>
            <option value="">all industries</option>
            {facets.map((f: any) => <option key={f.industry} value={f.industry}>{f.industry || "(none)"} ({f.n})</option>)}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">any status</option>
            <option value="ok">ok</option>
            <option value="pending">pending</option>
            <option value="broken">broken</option>
            <option value="skipped">skipped</option>
          </select>
        </div>
      </div>
      <div className="card card-tight" style={{ padding: 0 }}>
        {cQ.isLoading ? (
          <div className="col" style={{ padding: 16, gap: 8 }}>
            {Array.from({ length: 8 }).map((_, i) => <div key={i} className="skel" />)}
          </div>
        ) : items.length === 0 ? (
          <div className="col" style={{ padding: 32, textAlign: "center", gap: 8 }}>
            <span style={{ fontSize: 36 }}>🏢</span>
            <h2 className="h2">No companies match your filters</h2>
            <p className="sm muted">Try clearing the search box or hitting Scrape + Score now from the Jobs tab.</p>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Company</th>
                <th>Industry</th>
                <th>HQ</th>
                <th>Source</th>
                <th>Jobs</th>
                <th>Status</th>
                <th>Last scrape</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c: any) => (
                <tr key={c.id}>
                  <td>
                    <a href={c.careers_url || "#"} target="_blank" rel="noreferrer" style={{ color: "inherit", textDecoration: "none" }}>
                      <div className="h3">{c.name}</div>
                      <div className="xs dim">{c.slug}{c.ticker ? ` · ${c.ticker}` : ""}</div>
                    </a>
                  </td>
                  <td>{c.industry ? <span className="tag tag-zinc">{c.industry}</span> : <span className="dim">—</span>}</td>
                  <td className="sm">{[c.hq_city || c.hq_state, c.hq_country].filter(Boolean).join(", ") || "—"}</td>
                  <td><span className="tag tag-violet">{c.source}</span>{c.source_rank ? <span className="dim xs" style={{ marginLeft: 4 }}>#{c.source_rank}</span> : null}</td>
                  <td className="mono"><strong>{c.jobs_count}</strong></td>
                  <td>
                    <span className={`tag ${c.scrape_status === "ok" ? "tag-emerald" : c.scrape_status === "broken" ? "tag-red" : "tag-amber"}`}>
                      {c.scrape_status}
                    </span>
                    {c.careers_kind && c.careers_kind !== "unknown" ? <span className="xs dim" style={{ marginLeft: 4 }}>{c.careers_kind}</span> : null}
                  </td>
                  <td className="sm dim">{c.scrape_last_at || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}