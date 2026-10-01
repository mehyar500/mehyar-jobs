#!/usr/bin/env python3
"""mehyar.jobs warmup campaign sender.

Day N of the Fibonacci warmup: select recipients, mint unsubscribe tokens,
send via Brevo, track in the shared D1 tables.

Usage:
  warmup-send.py --day N [--dry-run] [--live]

--dry-run (default): prints everything, sends nothing, writes nothing.
--live: actually sends. Requires the mint_unsub_tokens control-plane action
        to be deployed and the Brevo credential healthy.

Secrets: Brevo key via authd surrogates (brevo.py); unsubscribe signing
secret stays server-side (minted via the agent control plane). This script
never handles a raw credential.
"""
import json
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
import dynamic_credentials as dc
from dynamic_credentials import read_json_response

REPO = "/home/hatch/workspace/repos/mehyar-jobs"
WR = ["python3", "/home/hatch/workspace/skills/cloudflare/bin/wr.py",
      "d1", "execute", "mehyar-jobs", "--remote",
      "--config", "scanner-worker/wrangler.toml"]
BREVO = ["python3", "/home/hatch/workspace/skills/brevo/bin/brevo.py"]
AGENT_BASE = "https://jobs.mehyar.us"
AGENT_CRED = "custom.mehyar-agent"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"
BRAND = "mehyar.jobs"
FROM_NAME = "mehyar.jobs"
FROM_EMAIL = "info@mehyar.us"
APP_URL = "https://jobs.mehyar.us"


def volume_for_day(n):
    if n <= 0:
        return 0
    if n == 1:
        return 5
    if n == 2:
        return 10
    a, b = 5, 10
    for _ in range(3, n + 1):
        a, b = b, min(300, a + b)
    return b


def d1(sql):
    import re
    out = subprocess.run(WR + ["--command", sql], cwd=REPO,
                         capture_output=True, text=True, timeout=180)
    txt = out.stdout + out.stderr
    m = re.search(r"\[\s*\{\s*\"results\"", txt)
    if not m:
        raise RuntimeError("wr.py output unparseable: " + txt[-500:])
    # Wrangler may print warnings after the JSON (stderr merged in) —
    # decode only the first JSON value.
    blocks, _ = json.JSONDecoder().raw_decode(txt[m.start():])
    rows = []
    for blk in blocks:
        rows.extend(blk.get("results") or [])
    return rows


def d1_write(sql):
    out = subprocess.run(WR + ["--command", sql], cwd=REPO,
                         capture_output=True, text=True, timeout=180)
    if out.returncode != 0:
        raise RuntimeError("wr.py write failed: " + (out.stdout + out.stderr)[-800:])


def select_recipients(volume):
    rows = d1("""
        SELECT ec.email, ec.first_name
        FROM email_contact ec
        WHERE ec.source = 'legacy'
          AND ec.brand = 'mehyar.jobs'
          AND ec.status NOT IN ('opted_out', 'bounced', 'complained')
          AND ec.email NOT IN (SELECT recipient_email FROM warmup_campaign_sends)
        ORDER BY CASE WHEN ec.email LIKE '%@gmail.com' THEN 0 ELSE 1 END, ec.id ASC
    """)
    outlook_domains = {"outlook.com", "hotmail.com", "live.com", "msn.com"}
    outlook_max = max(1, int(volume * 0.25))
    picked, outlook_used = [], 0
    for r in rows:
        if len(picked) >= volume:
            break
        dom = (r["email"].split("@")[-1] or "").lower()
        if dom in outlook_domains and outlook_used >= outlook_max:
            continue
        if dom in outlook_domains:
            outlook_used += 1
        picked.append({"email": r["email"], "first_name": r.get("first_name") or ""})
    return picked, len(rows)


def mint_tokens(emails):
    body = json.dumps({"action": "mint_unsub_tokens", "brand": BRAND,
                       "emails": emails}).encode()
    req = urllib.request.Request(
        AGENT_BASE + "/api/agent/email/control", data=body, method="POST",
        headers={"Content-Type": "application/json", "User-Agent": UA})
    dc.add_surrogate_to_request(req, AGENT_CRED, allowed_hosts=["jobs.mehyar.us"])
    resp = urllib.request.urlopen(req, timeout=60)
    data = read_json_response(resp)
    if not data.get("ok"):
        raise RuntimeError("token mint failed: " + json.dumps(data)[:300])
    return data["tokens"]


SUBJECTS = [
    "Your resume, scored the way ATS software reads it",
    "How hiring software reads your resume",
    "see your resume the way hiring software sees it",
]

TEXT_TPL = """Hi {name},

Most resumes get filtered by software before a human ever sees them. Our ATS Mirror shows you exactly what that software sees — your score, and the specific fixes that raise it.

No account needed, about 60 seconds, free:
https://go.mehyar.us/e898SwPC

We also scan 7,000+ career pages daily and match openings to your background — the top fits land in your inbox, not a firehose.

— Mehyar
mehyar.jobs

---
Don't want these? One click and you're out, no questions:
{unsub}
"""

HTML_TPL = """<p>Hi {name},</p>
<p>Most resumes get filtered by software before a human ever sees them. Our
<b>ATS Mirror</b> shows you exactly what that software sees — your score,
and the specific fixes that raise it.</p>
<p>No account needed, about 60 seconds, free:<br>
<a href="https://go.mehyar.us/e898SwPC">Run the free scan &rarr;</a></p>
<p>We also scan 7,000+ career pages daily and match openings to your
background — the top fits land in your inbox, not a firehose.</p>
<p>— Mehyar<br>mehyar.jobs</p>
<hr><p style="font-size:12px;color:#777">Don't want these?
<a href="{unsub}">Unsubscribe in one click</a> — no questions asked.</p>"""


def esc(s):
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def build_email(recipient, unsub_url, day):
    subject = SUBJECTS[(day - 1) % len(SUBJECTS)]
    name = recipient["first_name"].strip().title() or "there"
    text = TEXT_TPL.format(name=name, app=APP_URL, unsub=unsub_url)
    html = HTML_TPL.format(name=esc(name), app=APP_URL, unsub=esc(unsub_url))
    return {
        "sender": {"name": FROM_NAME, "email": FROM_EMAIL},
        "to": [{"email": recipient["email"],
                "name": recipient["first_name"] or recipient["email"]}],
        "subject": subject,
        "textContent": text,
        "htmlContent": html,
        "headers": {
            "List-Unsubscribe": f"<{unsub_url}>",
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
        "tags": ["warmup", "mehyar.jobs", f"day-{day}"],
    }


def brevo_send(payload):
    out = subprocess.run(BREVO + ["call", "smtp/email", "POST", json.dumps(payload)],
                         capture_output=True, text=True, timeout=120)
    try:
        data = json.loads(out.stdout[out.stdout.find("{"):])
    except Exception:
        raise RuntimeError("brevo send unparseable: " + (out.stdout + out.stderr)[-600:])
    return data


def sql_esc(s):
    return str(s or "").replace("'", "''")


def main(argv):
    day = None
    live = "--live" in argv
    if "--day" in argv:
        day = int(argv[argv.index("--day") + 1])
    if not day or day < 1:
        print("usage: warmup-send.py --day N [--dry-run|--live]", file=sys.stderr)
        return 2

    volume = volume_for_day(day)
    print(f"day {day}: planned volume {volume} (mode: {'LIVE' if live else 'dry-run'})")

    # Scale-rule inputs: last 3 days' bounce/complaint rates.
    recent = d1(f"""
        SELECT campaign_day, sent_count, bounce_count
        FROM warmup_campaign_daily
        WHERE brand = '{BRAND}' AND campaign_day < {day}
        ORDER BY campaign_day DESC LIMIT 3
    """)
    for r in recent:
        sent = r["sent_count"] or 0
        br = (r["bounce_count"] or 0) / sent if sent else 0
        print(f"  prior day {r['campaign_day']}: sent={sent} bounce_rate={br:.2%}")
        if sent and br >= 0.02:
            print("  SCALE RULE: bounce spike — pausing. Report before sending more.")
            return 3

    picked, pool = select_recipients(volume)
    shortfall = volume - len(picked)
    print(f"  pool eligible: {pool}, selected: {len(picked)}, shortfall: {shortfall}")
    if shortfall > 0:
        print("  PAUSE SIGNAL: pool cannot fill volume — top up via sync-legacy-cohort.mjs --live")
        if live and not picked:
            return 4

    if not live:
        print("  dry-run: would mint tokens + send via Brevo + write D1 rows. No sends, no writes.")
        for p in picked[:5]:
            print(f"    would send: {p['email']}")
        if len(picked) > 5:
            print(f"    ... and {len(picked) - 5} more")
        return 0

    # LIVE path
    emails = [p["email"] for p in picked]
    tokens = mint_tokens(emails)
    print(f"  minted {len(tokens)} unsubscribe tokens")

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    sent_ok, sent_fail = 0, 0
    for p in picked:
        token = tokens.get(p["email"])
        if not token:
            print(f"  skip (no token): {p['email']}")
            sent_fail += 1
            continue
        unsub = f"{APP_URL}/unsubscribe?token={token}"
        payload = build_email(p, unsub, day)
        try:
            res = brevo_send(payload)
        except Exception as e:
            print(f"  send error {p['email']}: {e}")
            sent_fail += 1
            continue
        body = res.get("body") if isinstance(res.get("body"), dict) else {}
        msg_id = (res.get("messageId") or res.get("message-id")
                  or body.get("messageId") or body.get("message-id") or "")
        if not msg_id:
            print(f"  brevo rejected {p['email']}: {json.dumps(res)[:200]}")
            sent_fail += 1
            continue
        d1_write(f"""
            INSERT INTO email_contact (email, brand, source, status, first_name)
            VALUES ('{sql_esc(p["email"])}', '{BRAND}', 'legacy-warmup', 'pending', '{sql_esc(p["first_name"])}')
            ON CONFLICT(email, brand) DO NOTHING;
        """.replace("\n", " "))
        d1_write(f"""
            INSERT INTO warmup_campaign_sends
              (brand, campaign_day, recipient_email, sent_at, status, message_id, source)
            VALUES ('{BRAND}', {day}, '{sql_esc(p["email"])}', '{now}', 'sent', '{sql_esc(msg_id)}', 'legacy-daily');
        """.replace("\n", " "))
        sent_ok += 1

    date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    d1_write(f"""
        INSERT INTO warmup_campaign_daily
          (brand, campaign_day, date, planned_volume, sent_count, delivered_count,
           open_count, click_count, bounce_count, unsub_count)
        VALUES ('{BRAND}', {day}, '{date_str}', {volume}, {sent_ok}, 0, 0, 0, 0, 0)
        ON CONFLICT(brand, campaign_day) DO UPDATE SET sent_count = excluded.sent_count;
    """.replace("\n", " "))
    print(f"  done: sent={sent_ok} failed={sent_fail}")
    return 0 if sent_fail == 0 else 5


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
