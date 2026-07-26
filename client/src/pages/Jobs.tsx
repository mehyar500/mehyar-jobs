import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, getToken } from "../lib/api";

function fitClass(score?: number | null) {
  if (score == null) return "fit-0";
  if (score >= 90) return "fit-90";
  if (score >= 70) return "fit-70";
  if (score >= 50) return "fit-50";
  if (score >= 30) return "fit-30";
  return "fit-0";
}

function relativeTime(s?: string | null) {
  if (!s) return "—";
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return s;
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export default function Jobs() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [industry, setIndustry] = useState("");
  const [remote, setRemote] = useState("");
  const [fitMin, setFitMin] = useState(0);
  const [sort, setSort] = useState<"fit" | "recent" | "company">("fit");
  const [showHardNo, setShowHardNo] = useState(false);
  const [scraping, setScraping] = useState(false);
  const [scoring, setScoring] = useState(false);

  const params = useMemo(() => {
    const p: any = { sort, fit_min: fitMin };
    if (q) p.q = q;
    if (industry) p.industry = industry;
    if (remote) p.remote = remote;
    if (showHardNo) p.include_hard_no = 1;
    return p;
  }, [q, industry, remote, fitMin, sort, showHardNo]);

  const jobsQ = useQuery({
    queryKey: ["jobs", params],
    queryFn: () => api.jobs(params),
    refetchInterval: 60_000,
  });
  const statsQ = useQuery({
    queryKey: ["public-stats"],
    queryFn: () => api.publicStats(),
    refetchInterval: 60_000,
  });

  const items: any[] = jobsQ.data?.items || [];
  const total = jobsQ.data?.total || 0;
  const facets: any[] = jobsQ.data?.facets || [];

  const triggerScrape = async () => {
    setScraping(true);
    try {
      await api.triggerScrape();
      await api.triggerScore();
      qc.invalidateQueries({ queryKey: ["jobs"] });
      qc.invalidateQueries({ queryKey: ["public-stats"] });
    } catch (e) { console.error(e); }
    finally { setScraping(false); }
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      {/* Banner */}
      <div className="card">
        <div className="between wrap" style={{ gap: 12 }}>
          <div>
            <h1 className="h1">🎯 Top 5,000 careers, ranked by fit</h1>
            <p className="sm muted" style={{ marginTop: 4 }}>
              Daily scan of Fortune 500 + Forbes Global 2000 + Inc 5000 + S&P 500 career pages.
              Zero API keys — we crawl each company's public board (Greenhouse, Lever, Workday, Ashby, SmartRecruiters, plain HTML).
            </p>
          </div>
          <div className="row">
            <button className="btn btn-primary" onClick={triggerScrape} disabled={scraping || scoring}>
              {scraping ? "🔄 scraping…" : scoring ? "🔄 scoring…" : "🔄 Scrape + Score now"}
            </button>
          </div>
        </div>
        <div className="grid grid-4" style={{ marginTop: 12 }}>
          <Stat label="Companies" value={(statsQ.data as any)?.jobs ?? "—"} />
          <Stat label="Active jobs" value={(statsQ.data as any)?.jobs ?? "—"} />
          <Stat label="Last scrape" value={(statsQ.data as any)?.last_scrape_at ? relativeTime((statsQ.data as any).last_scrape_at) : "never"} />
          <Stat label="Total runs" value={(statsQ.data as any)?.scrape_runs ?? "—"} />
        </div>
      </div>

      {/* Filters */}
      <div className="card">
        <div className="grid" style={{ gridTemplateColumns: "2fr 1fr 1fr 1fr" }}>
          <input type="search" placeholder="Search title / description / company…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={industry} onChange={(e) => setIndustry(e.target.value)}>
            <option value="">all industries</option>
            {facets.map((f: any) => (
              <option key={f.industry} value={f.industry}>{f.industry || "(none)"} ({f.n})</option>
            ))}
          </select>
          <select value={remote} onChange={(e) => setRemote(e.target.value)}>
            <option value="">any location</option>
            <option value="remote">remote</option>
            <option value="hybrid">hybrid</option>
            <option value="onsite">on-site</option>
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value as any)}>
            <option value="fit">sort: fit score</option>
            <option value="recent">sort: recently added</option>
            <option value="company">sort: company (A→Z)</option>
          </select>
        </div>
        <div className="row wrap" style={{ marginTop: 10, gap: 6 }}>
          <span className="xs muted">fit ≥</span>
          {[0, 30, 50, 70, 90].map((n) => (
            <button key={n} className={`tab ${fitMin === n ? "active" : ""}`} onClick={() => setFitMin(n)}>{n}</button>
          ))}
          <span className="xs muted" style={{ marginLeft: 12 }}>·</span>
          <label className="row xs">
            <input type="checkbox" checked={showHardNo} onChange={(e) => setShowHardNo(e.target.checked)} />
            <span className="muted">include hard-no</span>
          </label>
          <span className="grow" />
          <span className="xs muted">{total.toLocaleString()} jobs · showing {items.length}</span>
        </div>
      </div>

      {/* Table */}
      <div className="card card-tight" style={{ padding: 0 }}>
        {jobsQ.isLoading ? (
          <div className="col" style={{ padding: 16, gap: 8 }}>
            {Array.from({ length: 8 }).map((_, i) => <div key={i} className="skel" />)}
          </div>
        ) : items.length === 0 ? (
          <div className="col" style={{ padding: 32, textAlign: "center", gap: 8 }}>
            <span style={{ fontSize: 36 }}>🤷</span>
            <h2 className="h2">No jobs match your filters</h2>
            <p className="sm muted">Try widening fit, clearing search, or hitting Scrape + Score now to refresh data.</p>
            <button className="btn btn-primary" onClick={triggerScrape} disabled={scraping}>
              {scraping ? "scraping…" : "Scrape + Score now"}
            </button>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 60 }}>Fit</th>
                <th>Title</th>
                <th>Company</th>
                <th>Industry</th>
                <th>Location</th>
                <th>Posted</th>
              </tr>
            </thead>
            <tbody>
              {items.map((j: any) => (
                <tr key={j.id}>
                  <td>
                    <span className={`fit-chip ${fitClass(j.score)}`} title={(j.reasons || []).join(" · ")}>
                      {j.score ?? "—"}
                    </span>
                  </td>
                  <td>
                    <a href={j.url} target="_blank" rel="noreferrer" style={{ color: "inherit", textDecoration: "none" }}>
                      <div className="h3">{j.title}</div>
                      {j.department ? <div className="xs dim">{j.department}{j.team ? " · " + j.team : ""}</div> : null}
                    </a>
                  </td>
                  <td>
                    <a href={`/companies?q=${encodeURIComponent(j.company_name)}`} className="row" style={{ color: "inherit", textDecoration: "none" }}>
                      {j.company_name}
                      {j.hq_country && j.hq_country !== "US" ? <span className="tag tag-zinc xs">{j.hq_country}</span> : null}
                    </a>
                  </td>
                  <td>{j.industry ? <span className="tag tag-zinc">{j.industry}</span> : <span className="dim">—</span>}</td>
                  <td>
                    {j.location || <span className="dim">—</span>}
                    {j.remote_policy && j.remote_policy !== "unknown" ? <span className={`tag tag-${j.remote_policy === "remote" ? "emerald" : j.remote_policy === "hybrid" ? "sky" : "zinc"} xs`} style={{ marginLeft: 4 }}>{j.remote_policy}</span> : null}
                  </td>
                  <td className="sm dim">{relativeTime(j.posted_at || j.first_seen_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: any }) {
  return (
    <div className="card card-tight" style={{ padding: 10 }}>
      <div className="xs muted" style={{ textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 600 }}>{label}</div>
      <div className="mono" style={{ fontSize: 18, fontWeight: 700 }}>{value}</div>
    </div>
  );
}