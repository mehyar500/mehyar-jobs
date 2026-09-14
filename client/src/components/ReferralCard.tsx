import { useEffect, useState } from "react";
import { api } from "../lib/api";

export default function ReferralCard() {
  const [ref, setRef] = useState<any>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { api.myReferral().then(setRef).catch(() => {}); }, []);
  return (
    <div className="card">
      <h2 className="h2">🎁 Invite friends, earn bonus AI chats</h2>
      <p className="sm muted" style={{ marginTop: 4 }}>
        Share your link — every friend who signs up gets <strong>+10 bonus AI chats</strong>, and so do you.
      </p>
      <div className="col" style={{ gap: 10, marginTop: 12 }}>
        {ref?.url ? (
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input type="text" readOnly value={ref.url} onFocus={(e) => e.target.select()} style={{ flex: "1 1 260px" }} />
            <button className="btn btn-primary btn-sm" onClick={() => {
              navigator.clipboard?.writeText(ref.url).catch(() => {});
              setCopied(true); setTimeout(() => setCopied(false), 2000);
            }}>{copied ? "✓ Copied" : "Copy invite link"}</button>
          </div>
        ) : <p className="sm muted">Loading your invite link…</p>}
        <div className="row sm" style={{ gap: 16 }}>
          <span>💬 Bonus chats banked: <strong>{ref?.chat_bonus_credits ?? "—"}</strong></span>
          <span>👥 Friends joined: <strong>{ref?.referred_count ?? "—"}</strong></span>
        </div>
      </div>
    </div>
  );
}
