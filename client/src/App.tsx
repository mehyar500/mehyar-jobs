import { useEffect, useState } from "react";
import { Route, Switch, Link, useLocation } from "wouter";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { api, getToken, login, clearToken } from "./lib/api";
import { ToastProvider, useToast } from "./lib/toast";
import Jobs from "./pages/Jobs";
import Companies from "./pages/Companies";
import Profile from "./pages/Profile";
import About from "./pages/About";
import Pipeline from "./pages/Pipeline";
import Today from "./pages/Today";
import { ApplicationsList, ApplicationDetail } from "./pages/Applications";

const qc = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
});

const TABS = [
  { key: "today",        label: "📅 Today",        href: "/" },
  { key: "jobs",         label: "🎯 Jobs",         href: "/jobs" },
  { key: "applications", label: "📤 Applications", href: "/applications" },
  { key: "companies",    label: "🏢 Companies",    href: "/companies" },
  { key: "pipeline",     label: "🧪 Pipeline",     href: "/pipeline" },
  { key: "profile",      label: "🪪 Profile",      href: "/profile" },
  { key: "about",        label: "ℹ️ How",          href: "/about" },
];

function Header({ loggedIn, principal, onLogout }: any) {
  const [loc] = useLocation();
  return (
    <header className="border-b" style={{ borderColor: "var(--border)" }}>
      <div className="container row" style={{ padding: "12px 16px" }}>
        <Link href="/" className="h2 row" style={{ textDecoration: "none", color: "inherit" }}>
          <span style={{ fontSize: 22 }}>🎯</span>
          <span>mehyar.jobs</span>
        </Link>
        <span className="tag tag-violet sm" style={{ marginLeft: 8 }}>top 5,000 careers, fit-scored</span>
        <div className="grow" />
        <div className="row wrap">
          {TABS.map((t) => (
            <Link key={t.key} href={t.href} className={`tab ${loc === t.href || (t.href !== "/" && loc.startsWith(t.href)) ? "active" : ""}`}>
              {t.label}
            </Link>
          ))}
        </div>
        <div className="row" style={{ marginLeft: 8 }}>
          {loggedIn ? (
            <>
              <span className="sm dim">signed in as <strong>{principal?.sub || "admin"}</strong></span>
              <button className="btn btn-ghost" onClick={onLogout}>logout</button>
            </>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: any) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await login(username, password);
      onLoggedIn();
    } catch (e: any) {
      setErr(e?.message || "login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="container" style={{ padding: "48px 16px", maxWidth: 460 }}>
      <div className="card">
        <h1 className="h1">Sign in to mehyar.jobs</h1>
        <p className="sm muted" style={{ marginTop: 4 }}>
          Same username + password as <a href="https://mehyar.us/admin" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>mehyar.us/admin</a>.
          We reuse your admin session across both apps.
        </p>
        <form onSubmit={submit} className="col" style={{ marginTop: 16, gap: 10 }}>
          <label className="col" style={{ gap: 4 }}>
            <span className="sm">Username</span>
            <input type="text" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
          </label>
          <label className="col" style={{ gap: 4 }}>
            <span className="sm">Password</span>
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          {err ? <div className="tag tag-red">{err}</div> : null}
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? "signing in…" : "Sign in"}
          </button>
        </form>
        <hr />
        <div className="sm muted">
          Cross-app single sign-on: the JWT you receive is valid on both <code className="mono">mehyar.us</code> and <code className="mono">jobs.mehyar.us</code>.
        </div>
      </div>
    </div>
  );
}

function Home() {
  return <Today />;
}

function Shell() {
  const token = getToken();
  const principal = JSON.parse(localStorage.getItem("mehyar_jobs_principal_v1") || "null");
  const [isLoggedIn, setIsLoggedIn] = useState(!!token);
  const toast = useToast();

  useEffect(() => {
    const onExpired = () => {
      clearToken();
      setIsLoggedIn(false);
      toast.push({ kind: "error", title: "Session expired", message: "Please sign in again." });
    };
    window.addEventListener("mehyar:auth-expired", onExpired);
    return () => window.removeEventListener("mehyar:auth-expired", onExpired);
  }, []);

  if (!isLoggedIn) {
    return <Login onLoggedIn={() => setIsLoggedIn(true)} />;
  }

  return (
    <>
      <Header
        loggedIn
        principal={principal}
        onLogout={() => { clearToken(); setIsLoggedIn(false); }}
      />
      <main className="container" style={{ padding: "16px" }}>
        <Switch>
          <Route path="/" component={Home} />
          <Route path="/jobs" component={Jobs} />
          <Route path="/companies" component={Companies} />
          <Route path="/applications" component={ApplicationsList} />
          <Route path="/applications/:id" component={ApplicationDetail} />
          <Route path="/profile" component={Profile} />
          <Route path="/pipeline" component={Pipeline} />
          <Route path="/about" component={About} />
          <Route><div className="card"><h2 className="h2">404</h2></div></Route>
        </Switch>
      </main>
      <footer className="container sm muted" style={{ padding: "24px 16px" }}>
        Owned by <a href="https://mehyar.us" style={{ color: "var(--accent)" }}>mehyar.us</a> · Zero API keys · Daily scan of public career pages.
      </footer>
    </>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </QueryClientProvider>
  );
}
