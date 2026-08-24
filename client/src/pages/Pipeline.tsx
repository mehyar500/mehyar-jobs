import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

function count(items: any[], status: string) {
  return items.find((item) => item.status === status)?.count || 0;
}

function time(value?: string | null) {
  if (!value) return "not yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function Pipeline() {
  const query = useQuery({ queryKey: ["pipeline"], queryFn: api.pipeline, refetchInterval: 30_000 });
  const data: any = query.data;
  if (query.isLoading) return <div className="card">Loading pipeline status...</div>;
  if (query.isError) return <div className="card">Could not load pipeline status.</div>;

  return <div className="col" style={{ gap: 16 }}>
    <div className="between wrap" style={{ gap: 12 }}>
      <div><h1 className="h1">Pipeline</h1><p className="sm muted" style={{ marginTop: 4 }}>Cloudflare stores the shared data. The local operator scores, queues, and submits supported Greenhouse/Ashby jobs up to the daily target.</p></div>
      <button className="btn" onClick={() => query.refetch()} disabled={query.isFetching}>Refresh</button>
    </div>
    <div className="grid grid-4">
      <Metric label="Active jobs" value={data.jobs?.active || 0} note={`${data.jobs?.total || 0} total`} />
      <Metric label="Ready to review" value={data.scores?.ready || 0} note={`${data.scores?.hard_no || 0} excluded`} />
      <Metric label="Queued" value={count(data.queue || [], "pending")} note={`${count(data.queue || [], "failed")} failed`} />
      <Metric label="Submitted today" value={data.today?.submitted || 0} note={`${data.today?.succeeded || 0} confirmed runs`} />
    </div>
    <div className="grid grid-2">
      <section className="card"><h2 className="h2">Collection and scoring</h2><div className="col sm" style={{ marginTop: 12, gap: 7 }}><Line label="Companies" value={`${data.companies?.total || 0} (${data.companies?.broken || 0} broken)`} /><Line label="Contract roles" value={data.engagement?.contract_jobs || 0} /><Line label="Last scrape" value={time(data.companies?.last_scrape_at)} /><Line label="Last scoring" value={time(data.scores?.last_scored_at)} /><Line label="Scheduled scan" value={data.scheduler?.completed_at ? `complete ${time(data.scheduler.completed_at)}` : data.scheduler ? `running · cursor ${data.scheduler.cursor}` : "not started"} /></div></section>
      <section className="card"><h2 className="h2">Review and applications</h2><div className="col sm" style={{ marginTop: 12, gap: 7 }}><Line label="Drafts" value={count(data.applications || [], "draft")} /><Line label="Submitted" value={count(data.applications || [], "submitted")} /><Line label="Queue in progress" value={count(data.queue || [], "in_flight")} /></div></section>
    </div>
    <section className="card card-tight" style={{ padding: 0 }}>
      <div style={{ padding: "14px 16px" }}><h2 className="h2">Recent collection runs</h2></div>
      <table className="responsive-table"><thead><tr><th>Started</th><th>Companies</th><th>Jobs found</th><th>New</th><th>Failed</th><th>Duration</th></tr></thead><tbody>
        {(data.scrape_runs || []).map((run: any) => <tr key={run.id}><td data-label="Started">{time(run.started_at)}</td><td data-label="Companies">{run.companies_succeeded}/{run.companies_attempted}</td><td data-label="Jobs found">{run.jobs_found}</td><td data-label="New">{run.new_jobs}</td><td data-label="Failed">{run.companies_failed}</td><td data-label="Duration">{run.duration_ms ? `${Math.round(run.duration_ms / 1000)}s` : "-"}</td></tr>)}
      </tbody></table>
    </section>
  </div>;
}

function Metric({ label, value, note }: { label: string; value: string | number; note: string }) {
  return <div className="card"><div className="xs muted">{label}</div><div className="h1" style={{ marginTop: 4 }}>{value}</div><div className="xs dim" style={{ marginTop: 4 }}>{note}</div></div>;
}

function Line({ label, value }: { label: string; value: string | number }) {
  return <div className="between"><span className="muted">{label}</span><strong>{value}</strong></div>;
}
