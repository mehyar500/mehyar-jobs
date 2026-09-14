// scripts/test-studio.mjs
// Tests the free-funnel: IP-gated free resume check, anon AI limits,
// tailor + cover-letter endpoints (with mocked Workers AI).
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureSchema } from "../functions/_shared/db.js";
import { clientIpHash, anonUsage, recordAnonUse } from "../functions/_shared/anonGate.js";
import { onRequestPost as publicPost } from "../functions/api/public/[[path]].js";
import { handleTailor, handleCoverLetter } from "../scanner-worker/src/studio.js";
import { handleChat } from "../scanner-worker/src/chat.js";
import { replyHallucinates, extractTitlesFromMessage, extractLocationFromMessage, firstSentences } from "../scanner-worker/src/chat.js";
import { signUserToken } from "../functions/_shared/userAuth.js";

class D1Shim {
  constructor() { this.db = new DatabaseSync(":memory:"); }
  prepare(sql) {
    const stmt = this.db.prepare(sql);
    const wrap = (params) => ({
      first: async () => stmt.get(...params) ?? null,
      all: async () => ({ results: stmt.all(...params) }),
      run: async () => {
        const r = stmt.run(...params);
        return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
      },
    });
    return { bind: (...p) => wrap(p), first: () => wrap([]).first(), all: () => wrap([]).all(), run: () => wrap([]).run() };
  }
  async batch(list) { const out = []; for (const s of list) out.push(await s.run()); return out; }
}

const env = { JOBS_DB: new D1Shim(), ADMIN_SESSION_SECRET: "test-secret-studio" };
await ensureSchema(env);
const db = env.JOBS_DB;

const req = (url, ip, body, token) => new Request(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "cf-connecting-ip": ip,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(body),
});

const RESUME = `
Jane Doe — Registered Nurse, BSN, RN license.
5 years of nursing experience in emergency department and ICU.
Skills: patient triage, IV therapy, EHR charting with Epic, ACLS/BLS certified,
wound care, medication administration, telemetry monitoring.
Worked at City General Hospital (2021-2026): reduced patient wait times,
mentored new nurses. Seeking a nursing role in Austin, TX.
`.repeat(2); // comfortably over 200 chars

// ── 1. anonGate: stable + distinct hashes ─────────────────────────────
{
  const mk = (ip) => new Request("https://x/", { headers: { "cf-connecting-ip": ip } });
  const h1 = await clientIpHash(mk("1.2.3.4"), env);
  const h2 = await clientIpHash(mk("1.2.3.4"), env);
  const h3 = await clientIpHash(mk("5.6.7.8"), env);
  assert.equal(h1, h2, "same IP must hash identically");
  assert.notEqual(h1, h3, "different IPs must hash differently");
  assert.equal(h1.length, 64);
  const u0 = await anonUsage(db, h1, "check");
  assert.equal(u0.usedEver, 0);
  await recordAnonUse(db, h1, "check");
  const u1 = await anonUsage(db, h1, "check");
  assert.equal(u1.usedEver, 1);
  assert.equal(u1.usedToday, 1);
  console.log("✓ anonGate hashing + usage counting");
}

// ── 2. free-run: first call scores, second call blocked ───────────────
await db.prepare(
  "INSERT INTO company (name, slug, source, industry, careers_url) VALUES ('City General Hospital','city-general','test','Healthcare','https://x')"
).run();
const comp = await db.prepare("SELECT id FROM company WHERE slug='city-general'").first();
await db.prepare(`INSERT INTO job (company_id, external_id, source_kind, title, description_text, location, remote_policy, employment_type, salary_min, salary_max, salary_currency, posted_at, first_seen_at, url, is_active)
  VALUES (?, 'ext-1', 'test', 'Registered Nurse - Emergency Department', 'Seeking RN with emergency department and ICU experience. Epic EHR charting, ACLS required.', 'Austin, TX', 'on_site', 'full_time', 75000, 95000, 'USD', datetime('now'), datetime('now'), 'https://x/j1', 1)`)
  .bind(comp.id).run();
await db.prepare(`INSERT INTO job (company_id, external_id, source_kind, title, description_text, location, remote_policy, employment_type, posted_at, first_seen_at, url, is_active)
  VALUES (?, 'ext-2', 'test', 'Senior Backend Engineer', 'Python and distributed systems.', 'Remote', 'remote', 'full_time', datetime('now'), datetime('now'), 'https://x/j2', 1)`)
  .bind(comp.id).run();

{
  const r1 = await publicPost({ request: req("https://jobs.mehyar.us/api/public/free-run", "9.9.9.9", { resume_text: RESUME }), env });
  assert.equal(r1.status, 200);
  const j1 = await r1.json();
  assert.equal(j1.ok, true);
  assert.ok(j1.matches.length >= 1, "nurse job should match the nurse resume");
  const nurse = j1.matches.find((m) => m.title.includes("Nurse"));
  assert.ok(nurse, "nurse match present");
  assert.equal(nurse.employment_type, "full_time");
  assert.equal(nurse.salary_min, 75000);
  assert.equal(nurse.location, "Austin, TX");
  assert.ok(j1.total_scored >= 2);
  console.log(`✓ free-run first check ok (top score ${j1.matches[0].score}, ${j1.matches.length} matches)`);

  const r2 = await publicPost({ request: req("https://jobs.mehyar.us/api/public/free-run", "9.9.9.9", { resume_text: RESUME }), env });
  assert.equal(r2.status, 429);
  const j2 = await r2.json();
  assert.equal(j2.error, "free_run_used");
  console.log("✓ free-run second check from same IP blocked (429 free_run_used)");

  // Different IP still gets its free check.
  const r3 = await publicPost({ request: req("https://jobs.mehyar.us/api/public/free-run", "8.8.8.8", { resume_text: RESUME }), env });
  assert.equal(r3.status, 200);
  console.log("✓ free-run works for a different IP");
}

// ── 2b. free-run: blob resume (one paragraph, no target title) still matches ──
{
  const BLOB = ("Alex Morgan, Senior Software Engineer with 8 years building distributed systems in Python and Go. Led migration of monolith to microservices at Fintech Corp serving 2M users. Skills: Python, Go, Kubernetes, AWS, PostgreSQL, Kafka. Designed real-time fraud detection pipeline reducing losses 30 percent. Mentored 5 junior engineers. BS Computer Science, UT Austin. Seeking senior backend roles in Austin Texas. ").repeat(2);
  const r = await publicPost({ request: req("https://jobs.mehyar.us/api/public/free-run", "7.7.7.7", { resume_text: BLOB }), env });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.title_guessed, true, "title should be guessed from blob resume");
  assert.ok(j.profile.target_titles.includes("Senior Software Engineer"), `guessed titles: ${JSON.stringify(j.profile.target_titles)}`);
  assert.ok(j.matches.length >= 1, "blob SWE resume should match the backend engineer job");
  assert.ok(j.matches.some((m) => m.title.includes("Backend Engineer")), "backend engineer match present");
  console.log(`✓ free-run blob resume: guessed "${j.profile.target_titles[0]}", ${j.matches.length} matches`);
}

// ── 2c. free-run: no guessable title → lower bar still surfaces keyword matches ──
{
  const NO_TITLE = ("I do patient triage and IV therapy with EHR charting. ACLS certified caregiver seeking work in a hospital setting with telemetry monitoring. ").repeat(3);
  const r = await publicPost({ request: req("https://jobs.mehyar.us/api/public/free-run", "6.6.6.6", { resume_text: NO_TITLE }), env });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.title_guessed, false, "no title should be guessable here");
  assert.ok(j.matches.length >= 1, "keyword-strong nurse job should surface without a title");
  console.log(`✓ free-run title-less resume: ${j.matches.length} matches via adaptive threshold`);
}

// ── 3. studio: anon AI daily limit enforced before AI is called ───────
const aiEnv = { ...env, AI: { run: async () => { throw new Error("AI should not be called"); } } };
{
  const ipHash = await clientIpHash(new Request("https://x/", { headers: { "cf-connecting-ip": "7.7.7.7" } }), env);
  for (let i = 0; i < 3; i++) await recordAnonUse(db, ipHash, "ai");
  const r = await handleTailor(req("https://w/tailor", "7.7.7.7", { resume_text: RESUME }), aiEnv);
  assert.equal(r.status, 429);
  const j = await r.json();
  assert.equal(j.error, "anon_ai_limit");
  console.log("✓ tailor: anon over daily AI limit blocked without calling AI");
}

// ── 4. studio: member tailor succeeds with mocked AI ──────────────────
await db.prepare(
  "INSERT INTO app_user (username, email, display_name, password_hash, newsletter_opt_in, is_admin) VALUES ('member1','m1@example.com','M','x',1,0)"
).run();
const member = await db.prepare("SELECT id FROM app_user WHERE username='member1'").first();
const token = await signUserToken(member.id, env);
const goodAI = { run: async () => ({ response: "JANE DOE\nSUMMARY\nRegistered Nurse with 5 years of emergency department and ICU experience, skilled in triage, IV therapy, and Epic EHR charting.\nSKILLS\nTriage, IV therapy, Epic EHR, ACLS/BLS\n---IMPROVEMENTS---\n- Quantify wait-time reduction\n- Add Epic keyword density" }) };
{
  const r = await handleTailor(
    req("https://w/tailor", "1.1.1.1", { resume_text: RESUME, target_role: "Registered Nurse" }, token),
    { ...env, AI: goodAI }
  );
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.ok(j.tailored_resume.includes("JANE DOE"));
  assert.equal(j.improvements.length, 2);
  console.log("✓ tailor: member gets tailored resume + improvements");
}

// ── 5. studio: cover letter with mocked AI + deterministic fallback ───
{
  const job = await db.prepare("SELECT id FROM job WHERE title LIKE 'Registered Nurse%'").first();
  const r = await handleCoverLetter(
    req("https://w/cover-letter", "1.1.1.1", { resume_text: RESUME, job_id: job.id }, token),
    { ...env, AI: { run: async () => ({ response: "Dear Hiring Manager,\n\nAs a Registered Nurse with 5 years of ED experience..." }) } }
  );
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.ok(j.cover_letter.length > 20);
  assert.equal(j.ai_drafted, true);
  console.log("✓ cover-letter: AI draft returned");

  // AI failure → deterministic fallback still returns a letter.
  const r2 = await handleCoverLetter(
    req("https://w/cover-letter", "1.1.1.1", { resume_text: RESUME, job_id: job.id }, token),
    { ...env, AI: { run: async () => { throw new Error("boom"); } } }
  );
  const j2 = await r2.json();
  assert.equal(j2.ok, true);
  assert.ok(j2.cover_letter.length > 20, "fallback letter present");
  assert.equal(j2.ai_drafted, false);
  console.log("✓ cover-letter: deterministic fallback on AI failure");
}

console.log("\nAll studio tests passed ✅");

// ── 6. chat: anon search + scoring + rate limit ────────────────────────
const chatAI = { run: async () => ({ response: "I found a great Registered Nurse role for you — Registered Nurse - Emergency Department at City General Hospital (55/100 fit). It matches your ICU background." }) };
{
  // Anonymous job query searches the DB and returns scored matches with links.
  const r = await handleChat(
    req("https://w/chat", "2.2.2.2", { message: "Find me nursing jobs in Austin" }),
    { ...env, AI: chatAI }
  );
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.ok(j.reply.length > 20, "chat reply present");
  assert.equal(j.searched, true, "job intent triggers DB search");
  assert.ok(j.matches.length >= 1, "at least one match returned");
  const nurse = j.matches.find((m) => m.title.includes("Nurse"));
  assert.ok(nurse, "nurse match present");
  assert.ok(typeof nurse.score === "number", "fit score present");
  assert.ok(nurse.score >= 15, "weak matches are filtered from cards");
  assert.ok(j.matches.every((m) => m.score >= 15), "all card matches meet the relevance floor");
  assert.ok(nurse.url, "apply link present");
  assert.equal(j.chat_remaining, 4, "anon chat budget decremented (5 -> 4)");
  console.log(`✓ chat: anon search returns ${j.matches.length} scored match(es) with links`);

  // Nonsense query → honest empty, not junk cards.
  const rN = await handleChat(
    req("https://w/chat", "9.9.9.9", { message: "Find me underwater basket weaving jobs" }),
    { ...env, AI: chatAI }
  );
  const jN = await rN.json();
  assert.equal(rN.status, 200);
  assert.equal(jN.matches.length, 0, "no junk cards for irrelevant query");
  assert.ok(jN.reply.length > 20, "AI explains honestly");
  console.log("✓ chat: irrelevant query returns zero matches, honest reply");

  // Greeting stays conversational — no DB search.
  const r2 = await handleChat(
    req("https://w/chat", "2.2.2.2", { message: "hello" }),
    { ...env, AI: chatAI }
  );
  const j2 = await r2.json();
  assert.equal(r2.status, 200);
  assert.equal(j2.searched, false, "greeting does not search");
  console.log("✓ chat: greeting handled conversationally");

  // Exhaust the anon daily budget (5 total) → 6th is rate-limited.
  for (let i = 0; i < 3; i++) {
    await handleChat(req("https://w/chat", "2.2.2.2", { message: "nurse jobs" }), { ...env, AI: chatAI });
  }
  const r3 = await handleChat(
    req("https://w/chat", "2.2.2.2", { message: "nurse jobs" }),
    { ...env, AI: { run: async () => { throw new Error("AI should not be called"); } } }
  );
  assert.equal(r3.status, 429);
  const j3 = await r3.json();
  assert.equal(j3.error, "chat_limit");
  console.log("✓ chat: anon rate limit enforced at 5/day without calling AI");

  // Member gets the bigger budget.
  const r4 = await handleChat(
    req("https://w/chat", "1.1.1.1", { message: "nurse jobs" }, token),
    { ...env, AI: chatAI }
  );
  assert.equal(r4.status, 200);
  const j4 = await r4.json();
  assert.equal(j4.chat_remaining, 29, "member chat budget decremented (30 -> 29)");
  console.log("✓ chat: member gets 30/day budget");
}

console.log("\nAll studio + chat tests passed ✅");

// ── 7. chat: hallucination guard + extractors (unit) ──────────────────
{
  assert.equal(replyHallucinates("Try Amazon - Software Engineer (94% match)", []), true);
  assert.equal(replyHallucinates("I found some at Google and Meta for you", []), true);
  assert.equal(replyHallucinates("• Amazon - great role", []), true);
  assert.equal(replyHallucinates("Card 1: great stuff", []), true);
  assert.equal(replyHallucinates("The role at Acme looks good", [{ company_name: "Initech" }]), true);
  assert.equal(replyHallucinates("I found 3 matches — the top ones are listed below.", [{ company_name: "Acme" }]), false);
  assert.equal(replyHallucinates("The role at Acme looks good", [{ company_name: "Acme Corp" }]), false);
  assert.deepEqual(extractTitlesFromMessage("Find me remote software engineer jobs"), ["Software Engineer"]);
  assert.deepEqual(extractTitlesFromMessage("nursing jobs in Austin"), ["Nurse"]);
  assert.deepEqual(extractLocationFromMessage("nursing jobs in Austin"), ["austin"]);
  assert.deepEqual(extractLocationFromMessage("remote python jobs"), []);
  assert.equal(firstSentences("Hello there. Here are matches below:\n\n[Card 1]\n[Card 2]"), "Hello there. Here are matches below:");
  console.log("✓ chat: hallucination guard + title/location extractors");
}

console.log("\nAll studio + chat + guard tests passed ✅");

// ── 8. parse-resume endpoint: PDF/DOCX upload → clean text ────────────────
import { deflateSync } from "node:zlib";
{
  const pdfEscape = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const mkPdf = (lines) => {
    const content = lines.map((l, i) => `BT /F1 12 Tf 72 ${700 - i * 18} Td (${pdfEscape(l)}) Tj ET`).join("\n");
    // /Filter /FlateDecode = RAW deflate (strip zlib wrapper).
    const compressed = deflateSync(Buffer.from(content, "latin1")).slice(2, -4);
    const objs = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
      `<< /Length ${compressed.length} /Filter /FlateDecode >>`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let pdf = Buffer.from("%PDF-1.4\n", "latin1");
    const offs = [];
    objs.forEach((o, i) => {
      offs[i + 1] = pdf.length;
      const head = Buffer.from(`${i + 1} 0 obj\n`, "latin1");
      const body = i === 3
        ? Buffer.concat([Buffer.from(o + "\nstream\n", "latin1"), compressed, Buffer.from("\nendstream\n", "latin1")])
        : Buffer.from(o + "\n", "latin1");
      pdf = Buffer.concat([pdf, head, body, Buffer.from("endobj\n", "latin1")]);
    });
    const xp = pdf.length;
    let xref = "xref\n0 6\n0000000000 65535 f \n";
    for (let i = 1; i <= 5; i++) xref += `${String(offs[i]).padStart(10, "0")} 00000 n \n`;
    pdf = Buffer.concat([pdf, Buffer.from(xref, "latin1"), Buffer.from(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xp}\n%%EOF`, "latin1")]);
    return pdf;
  };
  const mkDocx = (paras) => {
    const body = paras.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p.replace(/&/g, "&amp;")}</w:t></w:r></w:p>`).join("");
    const docXml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
    const ct = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/xml"/></Types>`;
    let out = Buffer.alloc(0);
    for (const [name, text] of [["[Content_Types].xml", ct], ["word/document.xml", docXml]]) {
      const raw = deflateSync(Buffer.from(text, "utf8")).slice(2, -4);
      const nb = Buffer.from(name, "utf8");
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(8, 8);
      h.writeUInt32LE(raw.length, 18); h.writeUInt16LE(nb.length, 26);
      out = Buffer.concat([out, h, nb, raw]);
    }
    return out;
  };
  const LINES = ["Jane Doe \u2014 Registered Nurse, BSN", "5 years emergency department and ICU experience at City General Hospital.", "Skills: patient triage, IV therapy, Epic EHR charting, ACLS/BLS certified, wound care,", "medication administration, telemetry monitoring. Mentored new nurses and reduced patient wait times.", "Seeking a nursing role in Austin, TX. References available on request."];
  const postFile = (buf, name, type, ip) => {
    const fd = new FormData();
    fd.append("file", new File([buf], name, { type }));
    return publicPost({ request: new Request("https://jobs.mehyar.us/api/public/parse-resume", {
      method: "POST", headers: { "cf-connecting-ip": ip }, body: fd,
    }), env });
  };

  const rp = await postFile(mkPdf(LINES), "resume.pdf", "application/pdf", "10.10.10.1");
  assert.equal(rp.status, 200);
  const jp = await rp.json();
  assert.equal(jp.ok, true);
  assert.equal(jp.format, "pdf");
  assert.ok(jp.text.includes("Registered Nurse"), "pdf text extracted");
  assert.ok(!/[�]/.test(jp.text), "no mojibake in pdf extraction");
  console.log(`✓ parse-resume: pdf → ${jp.char_count} clean chars`);

  const rd = await postFile(mkDocx(LINES), "resume.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "10.10.10.2");
  assert.equal(rd.status, 200);
  const jd = await rd.json();
  assert.equal(jd.ok, true);
  assert.equal(jd.format, "docx");
  assert.ok(jd.text.includes("Registered Nurse"), "docx text extracted");
  console.log(`✓ parse-resume: docx → ${jd.char_count} clean chars`);

  // The extracted PDF text feeds free-run and produces the RELEVANT job on top.
  const rr = await publicPost({ request: req("https://jobs.mehyar.us/api/public/free-run", "10.10.10.3", { resume_text: jp.text }), env });
  assert.equal(rr.status, 200);
  const jr = await rr.json();
  assert.ok(jr.ok && jr.matches.length >= 1);
  assert.ok(jr.matches[0].title.includes("Nurse"), `relevant job ranked first, got: ${jr.matches[0].title}`);
  assert.ok(!jr.matches.some((m) => m.title.includes("Backend Engineer") && m.score > jr.matches[0].score),
    "irrelevant backend job must not outrank the nurse job");
  console.log(`✓ end-to-end: uploaded PDF → relevant "${jr.matches[0].title}" ranked #1 (score ${jr.matches[0].score})`);

  // Binary garbage → friendly 422, never mojibake.
  const bad = await postFile(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64, 7)]), "resume.doc", "application/msword", "10.10.10.4");
  assert.equal(bad.status, 422);
  const jb = await bad.json();
  assert.equal(jb.error, "legacy_doc");
  console.log("✓ parse-resume: legacy .doc rejected with a helpful message");

  // Rate limit: 30 parses/day per IP.
  for (let i = 0; i < 30; i++) {
    await postFile(mkPdf(["x ".repeat(60)]), "r.pdf", "application/pdf", "10.10.10.9");
  }
  const rl = await postFile(mkPdf(["x ".repeat(60)]), "r.pdf", "application/pdf", "10.10.10.9");
  assert.equal(rl.status, 429);
  console.log("✓ parse-resume: per-IP daily cap enforced (429)");
}

console.log("\nAll resume-import tests passed ✅");
process.exit(0);
