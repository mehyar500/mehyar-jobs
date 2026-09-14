import { Link, useLocation } from "wouter";

export default function MobileTabBar({ session }: { session: "admin" | "user" | null }) {
  const [loc] = useLocation();
  if (session === "admin") return null;
  const active = (href: string) =>
    (href === "/" ? loc === "/" : loc === href || loc.startsWith(href + "/")) ? "active" : "";

  const tabs = [
    { label: "Home", ico: "🏠", href: "/" },
    { label: "Studio", ico: "🎯", href: "/studio" },
    { label: "Review", ico: "🤖", href: "/review" },
    { label: session === "user" ? "Matches" : "Sign up", ico: session === "user" ? "⭐" : "👤", href: session === "user" ? "/matches" : "/signup" },
  ];

  return (
    <nav className="mobile-tabs" aria-label="App navigation">
      {tabs.map((t) => (
        <Link key={t.href + t.label} href={t.href} className={active(t.href)} aria-label={t.label}>
          <span className="tab-ico">{t.ico}</span>
          <span>{t.label}</span>
        </Link>
      ))}
      <button
        className="tab-btn"
        aria-label="Ask the job AI"
        onClick={() => window.dispatchEvent(new CustomEvent("mhj:open-chat"))}
      >
        <span className="tab-ico">💬</span>
        <span>AI chat</span>
      </button>
    </nav>
  );
}
