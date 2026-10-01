import { Link } from "wouter";

export default function Footer({ session }: { session: "admin" | "user" | null }) {
  return (
    <footer className="site-footer">
      <div className="container col" style={{ gap: 16 }}>
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
          <div className="col" style={{ gap: 6, maxWidth: 340 }}>
            <div className="row" style={{ gap: 8 }}>
              <span style={{ fontSize: 20 }}>🎯</span>
              <strong>mehyar.jobs</strong>
            </div>
            <p className="sm muted" style={{ margin: 0 }}>
              Every job, matched to you. Daily scans of public career pages across every industry, scored against your resume.
            </p>
          </div>
          <div className="row" style={{ gap: 32, flexWrap: "wrap" }}>
            <div className="col" style={{ gap: 6 }}>
              <strong className="sm">Our products</strong>
              <a href="https://mehyar.us" className="sm muted">mehyar.us — software studio</a>
              <a href="https://aimech.app" className="sm muted">aimech.app — AI car diagnostics</a>
              <a href="https://rizza.app" className="sm muted">rizza.app — AI dating wingman</a>
              <a href="mailto:info@mehyar.us" className="sm muted">Contact: info@mehyar.us</a>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <strong className="sm">Product</strong>
              <Link href="/" className="sm muted">Browse jobs</Link>
              <Link href="/review" className="sm muted">AI resume review</Link>
              <Link href="/advertise" className="sm muted">⭐ Advertise / feature a job</Link>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <strong className="sm">Account</strong>
              {session === null ? (
                <>
                  <Link href="/signup" className="sm muted">Sign up free</Link>
                  <Link href="/login" className="sm muted">Log in</Link>
                </>
              ) : (
                <>
                  <Link href="/run" className="sm muted">Run my resume</Link>
                  <Link href="/matches" className="sm muted">My matches</Link>
                </>
              )}
              <Link href="/unsubscribe" className="sm muted">Unsubscribe</Link>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <strong className="sm">Legal</strong>
              <Link href="/terms" className="sm muted">Terms of Service</Link>
              <Link href="/privacy" className="sm muted">Privacy Policy</Link>
            </div>
          </div>
        </div>
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
          <span className="sm muted">Owned by <a href="https://mehyar.us" style={{ color: "var(--accent)" }}>mehyar.us</a> · © 2026</span>
        </div>
      </div>
    </footer>
  );
}
