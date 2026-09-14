import { useEffect, useState } from "react";
import { Link } from "wouter";
import { api, getToken } from "../lib/api";

export default function Unsubscribe() {
  const [state, setState] = useState<"idle" | "working" | "done" | "error" | "form">("idle");
  const [email, setEmail] = useState("");
  const [detail, setDetail] = useState("");
  const loggedIn = !!getToken();

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (token) {
      setState("working");
      api.unsubscribe(token)
        .then((r: any) => {
          if (r?.ok) { setState("done"); }
          else { setState("error"); setDetail("That link looks invalid or expired."); }
        })
        .catch(() => { setState("error"); setDetail("Something went wrong. Try again in a moment."); });
    } else {
      setState("form");
    }
  }, []);

  async function oneClickAccount() {
    setState("working");
    try {
      await api.setNewsletter(false);
      setState("done");
    } catch {
      setState("error");
      setDetail("Couldn't update your preference. Try again in a moment.");
    }
  }

  async function requestLink(e: any) {
    e.preventDefault();
    setState("working");
    try {
      await api.requestUnsubscribe(email);
      setState("done");
      setDetail("emailed");
    } catch {
      setState("error");
      setDetail("Something went wrong. Try again in a moment.");
    }
  }

  return (
    <div className="container" style={{ padding: "48px 16px", maxWidth: 560 }}>
      <div className="card col" style={{ gap: 12 }}>
        <h1 className="h1">Unsubscribe</h1>

        {state === "working" && <p className="sm muted">Working on it…</p>}

        {state === "done" && (
          <>
            <div className="tag tag-green">✓ You're unsubscribed</div>
            {detail === "emailed" ? (
              <p className="sm muted">
                If that email is on our list, a one-click unsubscribe link is on its way.
                Check your inbox (and spam folder).
              </p>
            ) : (
              <p className="sm muted">
                You won't receive digest or newsletter emails anymore. Your account and
                saved matches are untouched — you can re-enable emails any time from the Run page.
              </p>
            )}
            <Link href="/"><button className="btn">← Back to jobs</button></Link>
          </>
        )}

        {state === "error" && (
          <>
            <div className="tag tag-red">Couldn't unsubscribe</div>
            <p className="sm muted">{detail}</p>
            <button className="btn" onClick={() => setState("form")}>Try another way</button>
          </>
        )}

        {state === "form" && (
          <>
            {loggedIn ? (
              <>
                <p className="sm muted">
                  You're signed in — one click stops all digest and newsletter emails for this account.
                </p>
                <button className="btn btn-primary" onClick={oneClickAccount}>Unsubscribe this account</button>
              </>
            ) : (
              <>
                <p className="sm muted">
                  Enter the email you signed up with and we'll send you a one-click unsubscribe link.
                  (Links in our emails also unsubscribe instantly — no login needed.)
                </p>
                <form onSubmit={requestLink} className="col" style={{ gap: 10 }}>
                  <input className="input" type="email" required placeholder="you@example.com"
                    value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
                  <button className="btn btn-primary" type="submit">Email me the link</button>
                </form>
                <p className="sm muted">
                  Have an account? <Link href="/login" style={{ color: "var(--accent)" }}>Log in</Link> to
                  unsubscribe instantly.
                </p>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
