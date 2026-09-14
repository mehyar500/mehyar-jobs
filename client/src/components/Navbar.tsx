import { useState } from "react";
import { Link, useLocation } from "wouter";

const ADMIN_TABS = [
  { key: "today",        label: "📅 Today",        href: "/" },
  { key: "jobs",         label: "🎯 Jobs",         href: "/jobs" },
  { key: "applications", label: "📤 Applications", href: "/applications" },
  { key: "companies",    label: "🏢 Companies",    href: "/companies" },
  { key: "pipeline",     label: "🧪 Pipeline",     href: "/pipeline" },
  { key: "profile",      label: "🪪 Profile",      href: "/profile" },
  { key: "about",        label: "ℹ️ How",          href: "/about" },
];

const PUBLIC_LINKS = [
  { label: "🔎 Browse jobs", href: "/" },
  { label: "🪞 ATS Mirror", href: "/ats-mirror" },
  { label: "🎯 Free resume studio", href: "/studio" },
  { label: "🤖 AI resume review", href: "/review" },
];

export default function Navbar({ principal, session, onLogout }: {
  principal: any;
  session: "admin" | "user" | null;
  onLogout: () => void;
}) {
  const [loc] = useLocation();
  const [open, setOpen] = useState(false);
  const active = (href: string) => (href === "/" ? loc === "/" : loc === href || loc.startsWith(href + "/")) ? "active" : "";

  return (
    <header className="navbar">
      <div className="container navbar-inner">
        <Link href="/" className="brand" onClick={() => setOpen(false)}>
          <img src="/apple-touch-icon.png" alt="mehyar.jobs" style={{ width: 30, height: 30, borderRadius: 8 }} />
          <span className="brand-name">mehyar.jobs</span>
          {session !== "admin" && <span className="tag tag-violet sm hide-sm">every industry, fit-scored</span>}
        </Link>

        {/* Desktop links */}
        <nav className="nav-links hide-mobile">
          {session === "admin" ? (
            ADMIN_TABS.map((t) => <Link key={t.key} href={t.href} className={`tab ${active(t.href)}`}>{t.label}</Link>)
          ) : (
            <>
              {PUBLIC_LINKS.map((l) => <Link key={l.href} href={l.href} className={`tab ${active(l.href)}`}>{l.label}</Link>)}
              {session === "user" && (
                <>
                  <Link href="/run" className={`tab ${active("/run")}`}>📄 Run my resume</Link>
                  <Link href="/matches" className={`tab ${active("/matches")}`}>⭐ My matches</Link>
                </>
              )}
            </>
          )}
        </nav>

        <div className="grow" />

        {/* Auth area */}
        <div className="row hide-mobile" style={{ gap: 8 }}>
          {session === "admin" && (
            <>
              <span className="sm dim">admin <strong>{principal?.sub}</strong></span>
              <button className="btn btn-ghost" onClick={onLogout}>logout</button>
            </>
          )}
          {session === "user" && (
            <>
              <span className="sm dim">👋 <strong>{principal?.user?.display_name || principal?.user?.email || "member"}</strong></span>
              <button className="btn btn-ghost" onClick={onLogout}>logout</button>
            </>
          )}
          {session === null && (
            <>
              <Link href="/login"><button className="btn btn-ghost">Log in</button></Link>
              <Link href="/signup"><button className="btn btn-primary">Sign up free</button></Link>
            </>
          )}
        </div>

        {/* Mobile hamburger */}
        <button className="btn btn-ghost show-mobile" aria-label="Menu" onClick={() => setOpen((o) => !o)}>
          {open ? "✕" : "☰"}
        </button>
      </div>

      {/* Mobile dropdown */}
      {open && (
        <nav className="container nav-mobile show-mobile col" style={{ gap: 4, paddingBottom: 12 }}>
          {session === "admin" ? (
            ADMIN_TABS.map((t) => <Link key={t.key} href={t.href} className={`tab ${active(t.href)}`} onClick={() => setOpen(false)}>{t.label}</Link>)
          ) : (
            <>
              {PUBLIC_LINKS.map((l) => <Link key={l.href} href={l.href} className={`tab ${active(l.href)}`} onClick={() => setOpen(false)}>{l.label}</Link>)}
              {session === "user" && (
                <>
                  <Link href="/run" className={`tab ${active("/run")}`} onClick={() => setOpen(false)}>📄 Run my resume</Link>
                  <Link href="/matches" className={`tab ${active("/matches")}`} onClick={() => setOpen(false)}>⭐ My matches</Link>
                </>
              )}
              {session === null ? (
                <div className="row" style={{ gap: 8, marginTop: 8 }}>
                  <Link href="/login" onClick={() => setOpen(false)}><button className="btn btn-ghost">Log in</button></Link>
                  <Link href="/signup" onClick={() => setOpen(false)}><button className="btn btn-primary">Sign up free</button></Link>
                </div>
              ) : (
                <button className="btn btn-ghost" style={{ marginTop: 8, alignSelf: "flex-start" }}
                  onClick={() => { setOpen(false); onLogout(); }}>
                  logout{principal?.user?.display_name ? ` (${principal.user.display_name})` : ""}
                </button>
              )}
            </>
          )}
        </nav>
      )}
    </header>
  );
}
