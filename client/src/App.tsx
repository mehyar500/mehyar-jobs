import { useEffect, useState } from "react";
import { Route, Switch } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api, getToken, login, clearToken, getPrincipal } from "./lib/api";
import { ToastProvider, useToast } from "./lib/toast";
import Navbar from "./components/Navbar";
import Footer from "./components/Footer";
import Jobs from "./pages/Jobs";
import Companies from "./pages/Companies";
import Profile from "./pages/Profile";
import About from "./pages/About";
import Pipeline from "./pages/Pipeline";
import Today from "./pages/Today";
import { ApplicationsList, ApplicationDetail } from "./pages/Applications";
import Landing from "./pages/Landing";
import Signup from "./pages/Signup";
import UserLogin from "./pages/UserLogin";
import Run from "./pages/Run";
import Matches from "./pages/Matches";
import Review from "./pages/Review";
import AtsMirror from "./pages/AtsMirror";
import Studio from "./pages/Studio";
import Terms from "./pages/Terms";
import Privacy from "./pages/Privacy";
import Unsubscribe from "./pages/Unsubscribe";
import Advertise from "./pages/Advertise";
import RecruiterMatch from "./pages/RecruiterMatch";
import ChatWidget from "./components/ChatWidget";
import MobileTabBar from "./components/MobileTabBar";

const qc = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
});

function AdminLogin({ onLoggedIn }: { onLoggedIn: () => void }) {
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
        <h1 className="h1">Admin sign in</h1>
        <p className="sm muted" style={{ marginTop: 4 }}>
          Same username + password as <a href="https://mehyar.us/admin" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>mehyar.us/admin</a>.
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
      </div>
    </div>
  );
}

function Shell() {
  const [sessionKey, setSessionKey] = useState(0);
  const token = getToken();
  const principal = getPrincipal();
  const session: "admin" | "user" | null = !token ? null : (String(principal?.sub || "").startsWith("user:") ? "user" : "admin");
  const toast = useToast();

  useEffect(() => {
    const onExpired = () => {
      clearToken();
      setSessionKey((k) => k + 1);
      toast.push({ kind: "error", title: "Session expired", message: "Please sign in again." });
    };
    window.addEventListener("mehyar:auth-expired", onExpired);
    return () => window.removeEventListener("mehyar:auth-expired", onExpired);
  }, []);

  const logout = () => { clearToken(); setSessionKey((k) => k + 1); };

  return (
    <div key={sessionKey}>
      <Navbar principal={principal} session={session} onLogout={logout} />
      <main className="container" style={{ padding: "16px" }}>
        <Switch>
          {/* Public */}
          <Route path="/" component={session === "admin" ? Today : Landing} />
          <Route path="/signup" component={Signup} />
          <Route path="/login" component={session === "admin" ? Today : UserLogin} />
          <Route path="/run" component={Run} />
          <Route path="/matches" component={Matches} />
          <Route path="/review" component={Review} />
          <Route path="/ats-mirror" component={AtsMirror} />
          <Route path="/studio" component={Studio} />
          <Route path="/about" component={About} />
          <Route path="/terms" component={Terms} />
          <Route path="/privacy" component={Privacy} />
          <Route path="/unsubscribe" component={Unsubscribe} />
          <Route path="/advertise" component={Advertise} />
          <Route path="/recruiter-match" component={RecruiterMatch} />
          <Route path="/admin"><AdminLogin onLoggedIn={() => setSessionKey((k) => k + 1)} /></Route>
          {/* Admin only */}
          {session === "admin" && (
            <>
              <Route path="/jobs" component={Jobs} />
              <Route path="/companies" component={Companies} />
              <Route path="/applications" component={ApplicationsList} />
              <Route path="/applications/:id" component={ApplicationDetail} />
              <Route path="/profile" component={Profile} />
              <Route path="/pipeline" component={Pipeline} />
            </>
          )}
          <Route><div className="card"><h2 className="h2">404</h2><p className="sm muted">That page doesn't exist.</p></div></Route>
        </Switch>
      </main>
      <Footer session={session} />
      <MobileTabBar session={session} />
      <ChatWidget />
    </div>
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
