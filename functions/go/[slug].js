// GET /go/<product-slug> — per-product review landing pages.
//
// Review-style, in Mayor's voice. Each page renders from its offer_slot
// row (headline, body, CTA config) plus the editorial review below.
// Every page carries a placeholder offer slot: headline, pain-point
// copy, CTA, and the 1200x628 creative spec. AFFILIATE-LINK-NEEDED:
// cta_url is empty until Mayor pastes his approved link — until then
// the CTA renders "coming soon" and no outbound affiliate click exists.
//
// One offer per touchpoint: this page is where the selling happens.
// SMS carries only the hook + deep link here, never a raw affiliate URL.

import { ensureSchema } from "../_shared/db.js";
import { getOfferSlots, mintLink } from "../_shared/sms.js";
import { getDaySlug, recordLandingClick, buildCampaignLandingView, notFoundPage } from "../_shared/landing.js";
import { getProductBySlug } from "../_shared/productCatalog.js";
import { verifyPrefToken } from "../_shared/userAuth.js";
import { pageChrome, APP_URL } from "../_shared/seo.js";

const CT = { "Content-Type": "text/html; charset=utf-8" };

// ── dated campaign slugs: /go/<date>-<token> (Worker 6) ────────────
// Each day's campaign email links here. The page carries the day's
// campaign context (template focus + product of the day) and resolves
// attribution per slug per day. Checked BEFORE the legacy offer-slot
// path below so old /go/<offer-slug> links keep working untouched.
async function datedGoHandler({ request, env, db, slug }) {
  const row = await getDaySlug(db, slug);
  if (!row) {
    return new Response(pageChrome({ title: "Not found — mehyar.jobs", noindex: true, body: notFoundPage("This daily-picks link has expired") }), { status: 404, headers: CT });
  }
  const appUrl = env.JOBS_APP_URL || APP_URL;
  const url = new URL(request.url);
  const prefToken = url.searchParams.get("c");
  let contactId = null;
  let validPrefToken = null;
  if (prefToken) {
    try {
      const em = await verifyPrefToken(prefToken, env);
      if (em) {
        validPrefToken = prefToken;
        const c = await db.prepare("SELECT id FROM email_contact WHERE email = ?").bind(em).first().catch(() => null);
        if (c) contactId = c.id;
      }
    } catch { /* anonymous click */ }
  }
  await recordLandingClick(db, {
    date: row.date, pageType: "go", slug,
    productSlug: row.product_slug || null,
    contactId, ip: request.headers.get("cf-connecting-ip"),
  });
  const product = row.product_slug ? await getProductBySlug(db, row.product_slug).catch(() => null) : null;
  const html = pageChrome({
    title: `Today's picks · ${row.date} — mehyar.jobs`,
    noindex: true,
    body: buildCampaignLandingView({ slugRow: row, product, appUrl, prefToken: validPrefToken }),
  });
  return new Response(html, { headers: { ...CT, "Cache-Control": "public, max-age=300" } });
}

function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Editorial reviews in Mayor's voice. Honest, direct, no fluff.
const REVIEWS = {
  "myperfectresume": {
    pain: "Your resume is getting filtered out before a human ever sees it.",
    review: [
      "Most resumes die in the ATS — the software that reads your resume before any hiring manager does. Bad formatting, missing keywords, no clear story. MyPerfectResume fixes the formatting problem in about 15 minutes.",
      "It's a guided builder: pick a recruiter-approved template, fill in your history, and it suggests bullet points that actually sound like achievements instead of job descriptions. You also get a matching cover letter, which matters more than people think.",
      "Is it a substitute for a pro writer? No. But if your resume looks like a Word doc from 2012, this is the fastest upgrade you can make today.",
    ],
    pros: ["Done in ~15 minutes", "ATS-friendly templates", "Pre-written bullet suggestions", "Matching cover letter included"],
    cons: ["Template-based — won't fix a weak work history", "Subscription billing — cancel after you land the job"],
    verdict: "The fastest resume upgrade for the money. If your resume is old, ugly, or getting zero callbacks, start here.",
  },
  "great-resumes-fast": {
    pain: "You're qualified, but your resume doesn't prove it.",
    review: [
      "Sometimes the problem isn't formatting — it's positioning. You've done the work but your resume reads like a task list. That's what a professional resume writer fixes.",
      "Great Resumes Fast pairs you with a certified writer who rebuilds your resume around the jobs you actually want: the right keywords, the right story, quantified wins. Turnaround is days, not weeks.",
      "This costs real money. It's worth it exactly once in your career — when you're stuck, underpaid, or switching lanes and your resume isn't opening doors.",
    ],
    pros: ["Certified professional writers", "Built around your target roles", "ATS-proof formatting", "Days, not weeks"],
    cons: ["Costs real money — not a budget option", "You still need to provide your history"],
    verdict: "Worth it once, when it matters. If you're mid-career and underpaid, a pro rewrite pays for itself in the first raise.",
  },
  "coursera": {
    pain: "The jobs you want keep asking for skills you don't have on paper.",
    review: [
      "Hiring managers filter on credentials. Google, Meta, and IBM career certificates on Coursera are the closest thing to a shortcut that actually works — they're built by the companies doing the hiring.",
      "Pick the certificate that matches the gap in your matches: IT Support, Data Analytics, UX Design, Project Management. Most take 3-6 months at 10 hours a week. That's one focused season to change your filter status.",
      "Don't collect certificates like trophies. Get ONE that matches the jobs you're applying to, finish it, and put the projects on your resume.",
    ],
    pros: ["Credentials from Google, Meta, IBM", "Job-ready in 3-6 months", "Financial aid available", "Counts toward real degree credit at some schools"],
    cons: ["Requires actual study time — no passive watching", "One certificate won't replace experience"],
    verdict: "The highest-ROI credential for career switchers. Pick the one your target jobs ask for and finish it.",
  },
  "udemy": {
    pain: "One missing skill is standing between you and the offer.",
    review: [
      "Sometimes you don't need a career overhaul — you need to learn the one tool the job posting mentions. Udemy is the fastest way to close a single skill gap, usually for less than a lunch.",
      "Wait for a sale (they run constantly — never pay full price), pick the highest-rated course in the exact skill, and build the project alongside it. Employers care about the project, not the certificate.",
      "My rule: one course, one project, one portfolio piece. Then stop learning and start applying.",
    ],
    pros: ["Dirt cheap on sale (often under $20)", "Learn exactly one skill fast", "Lifetime access", "Huge selection"],
    cons: ["Quality varies — check ratings and reviews", "No credential weight with employers"],
    verdict: "Best value for closing a single skill gap. Never pay full price — sales are constant.",
  },
  "skillshare": {
    pain: "Your portfolio doesn't show what you can actually do.",
    review: [
      "For creative and freelance work, nobody hires your resume — they hire your portfolio. Skillshare's project-based classes are built around making things: design work, video, illustration, freelancing skills.",
      "The format works if you're a maker: short classes, real projects, and a community posting their work. You learn by shipping, which is the only way creative skills stick.",
      "Pair it with a portfolio site and every class project becomes proof you can do the work.",
    ],
    pros: ["Project-based — you ship work, not just watch", "Strong for design/video/creative", "Cheap monthly plan", "Good for freelancers"],
    cons: ["Not for technical credentials", "You have to actually do the projects"],
    verdict: "Great for creatives building a portfolio. Learn by making, then show the work.",
  },
  "flexjobs": {
    pain: "Half the 'remote jobs' you find are scams, reposts, or bait.",
    review: [
      "Remote job search has a trust problem. FlexJobs solves it the boring way: humans vet every single listing. 30,000+ remote, hybrid, and flexible jobs with the scams already removed.",
      "It's a paid board, and that's the point — the fee keeps the junk out. If you've ever wasted a week chasing a fake remote listing, you know what that filtering is worth.",
      "Use it alongside the free boards, not instead of them. FlexJobs is where you look when you want remote-only and zero noise.",
    ],
    pros: ["Every listing human-vetted", "30,000+ flexible jobs", "No scams, no reposts, no bait", "Career resources included"],
    cons: ["Paid subscription", "Smaller volume than free aggregators"],
    verdict: "The cleanest remote job board. Worth the fee if you're serious about remote and tired of scams.",
  },
  "jobtestprep": {
    pain: "You nailed the interview, then the assessment test killed you.",
    review: [
      "More companies screen with aptitude and personality assessments before they ever talk to you. Most candidates walk in cold. That's a fixable problem.",
      "JobTestPrep has practice tests for 100+ major employers' assessments — cognitive, personality, situational judgment. Practice the format and you stop losing points to surprise.",
      "One evening of practice can be the difference between 'we went with another candidate' and an offer. Cheap insurance.",
    ],
    pros: ["Employer-specific practice tests", "Covers aptitude + personality + SJTs", "Immediate scoring and explanations"],
    cons: ["Won't help if you're wrong for the role", "Practice access is time-limited by plan"],
    verdict: "Cheap insurance for assessment-heavy hiring processes. Practice once, stop losing to the format.",
  },
  "designlab": {
    pain: "You want into design, but tutorials aren't getting you hired.",
    review: [
      "Design is a mentorship field. Watching tutorials doesn't get you hired — feedback on your work does. Designlab pairs you with a working designer who reviews your projects 1-on-1.",
      "You build real portfolio projects with a mentor's eyes on them, plus career coaching for the job hunt. That's the whole game in design: portfolio + someone who's hired designers telling you what's missing.",
      "It's a real investment. Only do it if you're committed to design as the career — not curious, committed.",
    ],
    pros: ["1-on-1 mentor feedback", "Real portfolio projects", "Career coaching included", "Built for career switchers"],
    cons: ["Serious money — not casual learning", "Requires real time commitment"],
    verdict: "The legit path into design for career switchers. Mentorship is what tutorials can't give you.",
  },
  "amazon-gear": {
    pain: "You look like a blurry thumbnail on the interview that matters.",
    review: [
      "Interviews are on video now. Bad lighting, a laptop mic, and a messy background quietly cost people offers — nobody tells you, they just pick the other candidate.",
      "This is my hand-picked kit: a decent webcam, a headset that doesn't echo, a light that makes you look alive, and the shirt that photographs well on Zoom. Total cost is less than one tank of gas used to matter.",
      "Set it up once. Every interview, every call, every first impression from now on looks professional.",
    ],
    pros: ["Hand-picked, no research needed", "Under $150 total", "Set up once, benefit forever"],
    cons: ["Won't fix being unprepared — still do the prep"],
    verdict: "The cheapest interview upgrade there is. Look like you take it seriously, because you do.",
  },
  "sponsor-sms": {
    pain: "",
    review: [
      "This slot is reserved for sponsors — brands that want to reach job seekers at the exact moment they're improving their careers.",
      "Sponsored placements are always labeled, flat-fee, and never compete with the job seeker's experience. One sponsor per touchpoint.",
    ],
    pros: ["Labeled, transparent placement", "High-intent career audience", "Flat-fee, no auction games"],
    cons: [],
    verdict: "Advertisers: this is where your brand meets people actively investing in their careers.",
  },
};

const CREATIVE_SPEC = "1200x628 creative — bold headline text, product in context, high contrast, readable at thumbnail size. No stock-photo clichés.";

function page({ slot, review, ctaUrl, appUrl }) {
  const sponsored = slot.slot_type === "sponsor";
  const ctaLabel = slot.cta_url ? (slot.cta_text || "Learn more") : "Coming soon — deal drops when it's live";
  const pros = (review.pros || []).map((p) => `<li>✅ ${esc(p)}</li>`).join("");
  const cons = (review.cons || []).map((p) => `<li>⚠️ ${esc(p)}</li>`).join("");
  const paras = (review.review || []).map((p) => `<p>${esc(p)}</p>`).join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,follow">
<title>${esc(slot.name)} — reviewed by mehyar.jobs</title>
<style>
  *{box-sizing:border-box} body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111827;background:#f9fafb;line-height:1.6}
  .wrap{max-width:720px;margin:0 auto;padding:24px 16px 64px}
  .top{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}
  .brand{font-weight:800;color:#1a56db;text-decoration:none}
  .sponsored{display:inline-block;font-size:11px;font-weight:800;letter-spacing:.08em;color:#b45309;background:#fef3c7;border-radius:6px;padding:4px 10px;margin-bottom:12px}
  h1{font-size:30px;line-height:1.25;margin:0 0 8px}
  .pain{font-size:17px;color:#374151;border-left:4px solid #1a56db;padding-left:14px;margin:18px 0}
  .hero{margin:20px 0;border:2px dashed #d1d5db;border-radius:12px;background:#fff;padding:28px;text-align:center;color:#6b7280;font-size:13px}
  .verdict{background:#eef2ff;border-radius:12px;padding:18px;margin:24px 0;font-size:16px}
  .verdict strong{color:#3730a3}
  ul{padding-left:20px} li{margin:6px 0}
  .cta{display:block;text-align:center;background:#1a56db;color:#fff;font-weight:800;font-size:18px;text-decoration:none;border-radius:12px;padding:16px;margin:28px 0}
  .cta.soon{background:#9ca3af;cursor:default}
  .fine{font-size:12px;color:#9ca3af;text-align:center;margin-top:32px}
  .email{margin-top:28px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:20px}
  .email input{width:100%;padding:12px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;margin:8px 0}
  .email button{background:#111827;color:#fff;border:0;border-radius:8px;padding:12px 20px;font-weight:700;font-size:15px;cursor:pointer}
</style>
</head>
<body>
<div class="wrap">
  <div class="top"><a class="brand" href="${esc(appUrl)}/">← mehyar.jobs</a></div>
  <span class="sponsored">${sponsored ? "SPONSORED PLACEMENT" : "SPONSORED · PARTNER REVIEW"}</span>
  <h1>${esc(slot.headline)}</h1>
  ${review.pain ? `<div class="pain">${esc(review.pain)}</div>` : ""}
  <div class="hero">🖼️ ${esc(CREATIVE_SPEC)}<br><span style="font-size:11px">(creative placeholder — final art ships with the live deal)</span></div>
  ${paras}
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
    <div><strong>What I like</strong><ul>${pros}</ul></div>
    <div><strong>Watch out for</strong><ul>${cons || "<li>—</li>"}</ul></div>
  </div>
  <div class="verdict"><strong>My verdict:</strong> ${esc(review.verdict)}</div>
  ${ctaUrl
    ? `<a class="cta" href="${esc(ctaUrl)}" rel="nofollow sponsored noopener">👉 ${esc(ctaLabel)}</a>`
    : `<div class="cta soon">🔒 ${esc(ctaLabel)}</div>`}
  <div class="email">
    <strong>Want the deal the moment it's live?</strong>
    <p style="margin:6px 0;color:#6b7280;font-size:14px">Drop your email — one message when this deal opens, never spam. Double opt-in.</p>
    <form method="POST" action="/api/public/offer-email">
      <input type="email" name="email" placeholder="you@example.com" required>
      <input type="hidden" name="source" value="go:${esc(slot.key)}">
      <button type="submit">Notify me →</button>
    </form>
  </div>
  <p class="fine">mehyar.jobs partner review. We may earn a commission if you buy through our link — it keeps job seekers free forever. Opinions are our own.</p>
</div>
</body>
</html>`;
}

export async function onRequestGet({ request, env, params }) {
  await ensureSchema(env).catch(() => null);
  const db = env?.JOBS_DB;
  const slug = String(params?.slug || "").toLowerCase();

  // Dated campaign slugs (/go/2026-09-15-<token>) resolve to the daily
  // campaign landing view. Everything else falls through to the legacy
  // offer-slot review pages below.
  if (/^(\d{4}-\d{2}-\d{2})-([a-z0-9]{6,16})$/.test(slug)) {
    return datedGoHandler({ request, env, db, slug });
  }

  const review = REVIEWS[slug];
  if (!review || !db) {
    return new Response("Not found", { status: 404 });
  }
  const slots = await getOfferSlots(db);
  const slot = slots.find((s) => s.key === slug);
  if (!slot) return new Response("Not found", { status: 404 });

  const appUrl = env.JOBS_APP_URL || "https://jobs.mehyar.us";
  let ctaUrl = null;
  if (slot.cta_url && String(slot.cta_url).trim()) {
    // Tap-tracked redirect through /r/ — never expose raw affiliate URLs
    // in SMS, and track clicks from every other surface too.
    const ip = request.headers.get("cf-connecting-ip") || null;
    const ua = request.headers.get("user-agent") || null;
    const target = String(slot.cta_url).trim();
    const publicId = await mintLink(db, { contactId: null, kind: "offer_click", targetUrl: target, offerSlot: slot.key });
    void ip; void ua;
    ctaUrl = `${appUrl}/r/${publicId}`;
  }
  return new Response(page({ slot, review, ctaUrl, appUrl }), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" },
  });
}
