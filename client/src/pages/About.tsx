export default function About() {
  return (
    <div className="col" style={{ gap: 16, maxWidth: 800 }}>
      <div className="card">
        <h1 className="h1">ℹ️ How this works</h1>
        <p className="sm muted" style={{ marginTop: 6 }}>
          mehyar.jobs is the career-discovery side of <a href="https://mehyar.us" style={{ color: "var(--accent)" }}>mehyar.us</a>.
          It is fully independent (separate Cloudflare Pages project, separate D1) but shares your admin login so you don't juggle credentials.
        </p>
      </div>

      <div className="card">
        <h2 className="h2">📡 Data sources (no API keys required)</h2>
        <ul className="sm muted" style={{ paddingLeft: 18, lineHeight: 1.7 }}>
          <li><strong>Fortune 500</strong> · <a href="https://fortune.com/ranking/fortune-500/" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>fortune.com/ranking/fortune-500</a></li>
          <li><strong>Fortune Global 500</strong> · <a href="https://fortune.com/ranking/global-500/" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>fortune.com/ranking/global-500</a></li>
          <li><strong>Forbes Global 2000</strong> · <a href="https://www.forbes.com/global2000/" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>forbes.com/global2000</a></li>
          <li><strong>S&amp;P 500</strong> · <a href="https://en.wikipedia.org/wiki/List_of_S%26P_500_companies" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>Wikipedia</a></li>
          <li><strong>Inc 5000</strong> · <a href="https://www.inc.com/inc5000" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>inc.com/inc5000</a></li>
        </ul>
      </div>

      <div className="card">
        <h2 className="h2">🛠 Career-page scrapers (zero secret)</h2>
        <p className="sm muted">Every pattern below is a public endpoint that returns JSON or HTML without an API key.</p>
        <table>
          <thead><tr><th>Board</th><th>Endpoint</th><th>Example</th></tr></thead>
          <tbody>
            <tr><td>Greenhouse</td><td><code className="mono">/v1/boards/{'{handle}'}/jobs</code></td><td>Capital One, Stripe, OpenAI</td></tr>
            <tr><td>Lever</td><td><code className="mono">/v0/postings/{'{handle}'}</code></td><td>Netflix, Notion, Linear</td></tr>
            <tr><td>Ashby</td><td><code className="mono">/posting-api/job-board/{'{handle}'}</code></td><td>OpenAI, Ramp</td></tr>
            <tr><td>SmartRecruiters</td><td><code className="mono">/v1/companies/{'{handle}'}/postings</code></td><td>Visa, Samsung, Bosch</td></tr>
            <tr><td>Workday</td><td><code className="mono">/ccx/api/v1/{'{tenant}'}/jobs</code></td><td>JPMorgan, Goldman Sachs, Pfizer</td></tr>
            <tr><td>Plain HTML</td><td>fetch + link extractor</td><td>Apple, Microsoft, Tesla</td></tr>
          </tbody>
        </table>
        <p className="sm muted" style={{ marginTop: 8 }}>
          LinkedIn's career pages gate aggressively — those companies are marked <code className="mono">linkedin</code> and skipped; we recommend their public board instead.
        </p>
      </div>

      <div className="card">
        <h2 className="h2">🎯 Fit-score model (deterministic)</h2>
        <table>
          <thead><tr><th>Component</th><th>+/-</th><th>How</th></tr></thead>
          <tbody>
            <tr><td>Title match</td><td>+30 to +50</td><td>Exact / contains / token-overlap against target titles with synonym expansion</td></tr>
            <tr><td>Keyword hit</td><td>+10 / +20</td><td>1 / ≥2 keywords found in title or description</td></tr>
            <tr><td>Location / remote</td><td>+10</td><td>Matches a preferred location or is remote (when required)</td></tr>
            <tr><td>Salary</td><td>+5 / -10</td><td>Above / below the user's floor</td></tr>
            <tr><td>Recent</td><td>+2 / +5</td><td>Posted within 14 / 30 days</td></tr>
            <tr><td>Preferred industry</td><td>+5</td><td>Industry in user's preferred list</td></tr>
            <tr><td>Hard no</td><td>filtered</td><td>Excluded keyword / industry / remote / salary below 85% of floor</td></tr>
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2 className="h2">🔐 Cross-app single sign-on</h2>
        <p className="sm muted">
          mehyar.jobs shares the JWT issued by mehyar-web's <code className="mono">/api/admin/auth/login</code>. Both apps verify with the same <code className="mono">MESC_JWT_SECRET</code> HMAC secret. No shared DB, no shared KV, no shared cookie domain — just cryptographic trust.
        </p>
      </div>

      <div className="card">
        <h2 className="h2">📅 Daily cycle</h2>
        <ol className="sm muted" style={{ paddingLeft: 18, lineHeight: 1.7 }}>
          <li>Cron triggers <code className="mono">/api/admin/cron/scrape</code></li>
          <li>Each company's careers URL is fetched; new jobs INSERTed, removed jobs marked inactive</li>
          <li><code className="mono">/api/admin/cron/score</code> runs immediately after — every active job re-scored against the latest profile</li>
          <li>Top-fit (≥70) and high-novelty (new in last 24h) jobs surface as alerts in /dash</li>
          <li>If a company board returns 4xx / 5xx three days running, its <code className="mono">scrape_status</code> flips to <code className="mono">broken</code> so you can intervene</li>
        </ol>
      </div>
    </div>
  );
}