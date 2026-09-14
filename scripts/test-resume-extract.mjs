// scripts/test-resume-extract.mjs — resume text extraction tests (PDF/DOCX/TXT).
// Run: node scripts/test-resume-extract.mjs
import { deflateSync } from "node:zlib";
import { extractResumeText, ExtractError } from "../functions/_shared/extractText.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

// --- fixture: minimal PDF with FlateDecode content stream -------------------
function pdfEscape(s) {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
function makePdf(lines) {
  const content = lines.map((l, i) =>
    `BT /F1 12 Tf 72 ${700 - i * 18} Td (${pdfEscape(l)}) Tj ET`
  ).join("\n");
  // /Filter /FlateDecode means RAW deflate — strip the zlib wrapper.
  const compressed = deflateSync(Buffer.from(content, "latin1")).slice(2, -4);
  const objs = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objs[3] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>";
  objs[4] = `<< /Length ${compressed.length} /Filter /FlateDecode >>`;
  objs[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let pdf = Buffer.from("%PDF-1.4\n", "latin1");
  const offsets = {};
  for (let i = 1; i <= 5; i++) {
    offsets[i] = pdf.length;
    const head = Buffer.from(`${i} 0 obj\n`, "latin1");
    const body = i === 4
      ? Buffer.concat([Buffer.from(objs[4] + "\nstream\n", "latin1"), compressed, Buffer.from("\nendstream\n", "latin1")])
      : Buffer.from(objs[i] + "\n", "latin1");
    pdf = Buffer.concat([pdf, head, body, Buffer.from("endobj\n", "latin1")]);
  }
  const xrefPos = pdf.length;
  let xref = `xref\n0 6\n0000000000 65535 f \n`;
  for (let i = 1; i <= 5; i++) xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf = Buffer.concat([pdf, Buffer.from(xref, "latin1"),
    Buffer.from(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`, "latin1")]);
  return new Uint8Array(pdf);
}

// --- fixture: minimal DOCX ---------------------------------------------------
function crc32() { return 0; } // stored entries skipped; we only emit deflated
function makeDocx(paragraphs) {
  const body = paragraphs.map((p) =>
    `<w:p><w:r><w:t xml:space="preserve">${p.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</w:t></w:r></w:p>`
  ).join("");
  const docXml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  const ct = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const files = { "[Content_Types].xml": ct, "word/document.xml": docXml };
  // hand-rolled zip with deflated local headers only
  let out = Buffer.alloc(0);
  for (const [name, text] of Object.entries(files)) {
    const data = deflateSync(Buffer.from(text, "utf8"), { level: 9 });
    // raw deflate expected by DecompressionStream('deflate-raw'): strip zlib header/trailer
    const raw = data.slice(2, data.length - 4);
    const nameBuf = Buffer.from(name, "utf8");
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0, 6);
    h.writeUInt16LE(8, 8); h.writeUInt16LE(0, 10); h.writeUInt16LE(0, 12);
    h.writeUInt32LE(0, 14); h.writeUInt32LE(raw.length, 18); h.writeUInt32LE(text.length, 22);
    h.writeUInt16LE(nameBuf.length, 26); h.writeUInt16LE(0, 28);
    out = Buffer.concat([out, h, nameBuf, raw]);
  }
  return new Uint8Array(out);
}

const RESUME_LINES = [
  "Mehyar Swellem — Senior Software Engineer",
  "New York, NY · mehyar@example.com · 555-0100",
  "EXPERIENCE",
  "Senior Software Engineer, Acme Corp (2021—Present)",
  "Built distributed systems in Node.js, TypeScript, and Go; led Kubernetes migration.",
  "SKILLS: TypeScript, React, Node.js, PostgreSQL, AWS, Terraform",
];

console.log("resume extraction tests");

const pdf = makePdf(RESUME_LINES);
const r1 = await extractResumeText(pdf, "resume.pdf", "application/pdf");
ok("pdf extracts name", r1.text.includes("Mehyar Swellem"), JSON.stringify(r1.text.slice(0, 120)));
ok("pdf extracts skills line", r1.text.includes("TypeScript, React, Node.js"));
ok("pdf has no mojibake", !/[�]/.test(r1.text) && !/%PDF/.test(r1.text));
ok("pdf format flagged", r1.format === "pdf");

// ToUnicode CMap: custom-encoded font must decode to the right glyphs,
// not weird symbols. <0003>→'J' <0004>→'a' <0005>→'n' <0006>→'e' <0007>→' '
// <0008>→'D' <0009>→'o' via beginbfchar + beginbfrange.
function makeCMapPdf() {
  const cmapText = `/CIDInit /ProcSet findresource begin
12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Custom-UTF16 def /CMapType 2 def
1 begincodespacerange <0000> <FFFF> endcodespacerange
5 beginbfchar <0003> <004A> <0004> <0061> <0005> <006E> <0006> <0065> <0007> <0020> endbfchar
2 beginbfrange <0008> <0008> <0044> <0009> <0009> <006F> endbfrange
endcmap CMapName currentdict /CMap defineresource pop end end`;
  const cmapRaw = deflateSync(Buffer.from(cmapText, "latin1")).slice(2, -4);
  const word = "00030004000500060007000800090007"; // "Jane Do "
  const content = `BT /F1 12 Tf 72 700 Td <${word.repeat(8)}> Tj ET`; // 64 chars, over the 50-char minimum
  const contentRaw = deflateSync(Buffer.from(content, "latin1")).slice(2, -4);
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 6 0 R >> >> >>",
    "<< /Type /Font /Subtype /Type0 /BaseFont /CustomFont /ToUnicode 4 0 R >>",
    `<< /Length ${cmapRaw.length} /Filter /FlateDecode >>`,
    `<< /Length ${contentRaw.length} /Filter /FlateDecode >>`,
  ];
  // objects: 1 catalog, 2 pages, 3 page, 4 cmap stream, 5 content stream, 6 font
  const order = [1, 2, 3, 6, 4, 5];
  const bodies = {
    1: objs[0], 2: objs[1], 3: objs[2], 6: objs[3],
    4: { dict: objs[4], stream: cmapRaw }, 5: { dict: objs[5], stream: contentRaw },
  };
  let pdf = Buffer.from("%PDF-1.4\n", "latin1");
  const offs = {};
  for (const i of order) {
    offs[i] = pdf.length;
    pdf = Buffer.concat([pdf, Buffer.from(`${i} 0 obj\n`, "latin1")]);
    const b = bodies[i];
    if (b.stream) {
      pdf = Buffer.concat([pdf, Buffer.from(b.dict + "\nstream\n", "latin1"), b.stream, Buffer.from("\nendstream\n", "latin1")]);
    } else {
      pdf = Buffer.concat([pdf, Buffer.from(b + "\n", "latin1")]);
    }
    pdf = Buffer.concat([pdf, Buffer.from("endobj\n", "latin1")]);
  }
  const xp = pdf.length;
  let xref = "xref\n0 7\n0000000000 65535 f \n";
  for (let i = 1; i <= 6; i++) xref += `${String(offs[i]).padStart(10, "0")} 00000 n \n`;
  pdf = Buffer.concat([pdf, Buffer.from(xref, "latin1"), Buffer.from(`trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xp}\n%%EOF`, "latin1")]);
  return new Uint8Array(pdf);
}
const rc = await extractResumeText(makeCMapPdf(), "cmap.pdf", "application/pdf");
ok("tounicode cmap decodes custom font", rc.text.includes("Jane Do"), `got: ${JSON.stringify(rc.text.slice(0, 40))}`);
ok("cmap pdf has no mojibake", !/[�]/.test(rc.text));

const docx = makeDocx(RESUME_LINES);
const r2 = await extractResumeText(docx, "resume.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
ok("docx extracts name", r2.text.includes("Mehyar Swellem"), JSON.stringify(r2.text.slice(0, 120)));
ok("docx extracts experience", r2.text.includes("Acme Corp"));
ok("docx format flagged", r2.format === "docx");

const txt = new TextEncoder().encode(RESUME_LINES.join("\n"));
const r3 = await extractResumeText(txt, "resume.txt", "text/plain");
ok("txt round-trips", r3.text.includes("Senior Software Engineer") && r3.format === "txt");

// windows-1252 smart quotes decode
const win = Uint8Array.from([0x48, 0x69, 0x20, 0x93, 0x71, 0x75, 0x6f, 0x74, 0x65, 0x94, 0x20, ...new TextEncoder().encode("x".repeat(60))]);
const r4 = await extractResumeText(win, "r.txt", "text/plain");
ok("win1252 smart quotes decode", r4.text.includes("\u201cquote\u201d"), JSON.stringify(r4.text.slice(0, 30)));

// binary garbage → friendly error, not mojibake
const garbage = new Uint8Array(400).map((_, i) => (i * 37 + 11) % 256);
let threw = null;
try { await extractResumeText(garbage, "resume.txt", "text/plain"); } catch (e) { threw = e; }
ok("binary garbage as .txt rejected cleanly", threw instanceof ExtractError && threw.code === "binary_file");

// signature beats extension: pdf bytes named .txt still parse as pdf
const r5 = await extractResumeText(pdf, "resume.txt", "text/plain");
ok("pdf signature wins over .txt name", r5.format === "pdf" && r5.text.includes("Mehyar Swellem"));

// legacy .doc → helpful message
const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3]);
threw = null;
try { await extractResumeText(ole, "resume.doc", "application/msword"); } catch (e) { threw = e; }
ok("legacy .doc gets convert message", threw instanceof ExtractError && threw.code === "legacy_doc");

// empty pdf → friendly error
threw = null;
try { await extractResumeText(makePdf(["hi"]), "empty.pdf", "application/pdf"); } catch (e) { threw = e; }
ok("empty pdf errors cleanly", threw instanceof ExtractError);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
