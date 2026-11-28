// Renders each US label in data/hcp/labels/ as an HL7 SPL document, the XML that FDA and DailyMed
// publish. The markdown stays the source a maintainer edits; the XML is generated from it, so the
// two can never disagree. Set id and version come from data/hcp/history/<family>.json.
// `node scripts/spl.mjs` writes data/hcp/spl/; check-dataset.mjs regenerates and compares.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url).pathname;

// LOINC codes for the top-level sections of a Physician Labeling Rule label.
export const LOINC = {
  0: ["34066-1", "BOXED WARNING SECTION"],
  1: ["34067-9", "INDICATIONS & USAGE SECTION"],
  2: ["34068-7", "DOSAGE & ADMINISTRATION SECTION"],
  3: ["43678-2", "DOSAGE FORMS & STRENGTHS SECTION"],
  4: ["34070-3", "CONTRAINDICATIONS SECTION"],
  5: ["43685-7", "WARNINGS AND PRECAUTIONS SECTION"],
  6: ["34084-4", "ADVERSE REACTIONS SECTION"],
  7: ["34073-7", "DRUG INTERACTIONS SECTION"],
  8: ["43684-0", "USE IN SPECIFIC POPULATIONS SECTION"],
  9: ["42227-9", "DRUG ABUSE AND DEPENDENCE SECTION"],
  10: ["34088-5", "OVERDOSAGE SECTION"],
  11: ["34089-3", "DESCRIPTION SECTION"],
  12: ["34090-1", "CLINICAL PHARMACOLOGY SECTION"],
  13: ["43680-8", "NONCLINICAL TOXICOLOGY SECTION"],
  14: ["34092-7", "CLINICAL STUDIES SECTION"],
  15: ["34093-5", "REFERENCES SECTION"],
  16: ["34069-5", "HOW SUPPLIED SECTION"],
  17: ["34076-0", "PATIENT COUNSELING INFORMATION"],
};
export const SUBSECTION = ["42229-5", "SPL UNCLASSIFIED SECTION"];
const DOCUMENT = ["34391-3", "HUMAN PRESCRIPTION DRUG LABEL"];

export const isUsLabel = (text) => /^doc_id:\s*\S*-uspi-/m.test(text) && /^country:\s*US\s*$/m.test(text);

// A stable UUID from a name, so regenerating gives the same bytes.
const uuid = (name) => {
  const h = createHash("sha1").update(name).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const inline = (s) =>
  esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<content styleCode="bold">$1</content>')
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<content styleCode="italics">$2</content>');

const cells = (row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

// Markdown body of one section to SPL narrative: paragraph, list/item (nested by indent), table.
export function narrative(body, pad) {
  const out = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.trim().startsWith("|")) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(lines[i++]);
      const [head, , ...rest] = rows;
      out.push(`${pad}<table>`, `${pad}  <thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>`, `${pad}  <tbody>`);
      for (const r of rest) out.push(`${pad}    <tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`);
      out.push(`${pad}  </tbody>`, `${pad}</table>`);
      continue;
    }
    if (/^\s*(-|\d+\.)\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*(-|\d+\.)\s/.test(lines[i])) {
        const m = lines[i++].match(/^(\s*)(-|\d+\.)\s+(.*)$/);
        items.push({ depth: Math.floor(m[1].length / 2), ordered: m[2] !== "-", text: m[3] });
      }
      out.push(...list(items, 0, pad));
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(-|\d+\.)\s/.test(lines[i]) && !lines[i].trim().startsWith("|")) para.push(lines[i++].trim());
    out.push(`${pad}<paragraph>${inline(para.join(" "))}</paragraph>`);
  }
  return out;
}

function list(items, depth, pad) {
  const out = [`${pad}<list listType="${items[0]?.ordered ? "ordered" : "unordered"}">`];
  for (let i = 0; i < items.length; ) {
    const it = items[i++];
    const kids = [];
    while (i < items.length && items[i].depth > depth) kids.push(items[i++]);
    if (kids.length === 0) out.push(`${pad}  <item>${inline(it.text)}</item>`);
    else out.push(`${pad}  <item>${inline(it.text)}`, ...list(kids, depth + 1, pad + "    "), `${pad}  </item>`);
  }
  out.push(`${pad}</list>`);
  return out;
}

export function parseLabel(text) {
  const [, front, body] = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const meta = Object.fromEntries(front.split("\n").map((l) => l.match(/^([a-z_]+):\s*(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
  const title = body.match(/^# (.+)$/m)[1];
  const sections = body.split(/^(?=## )/m).slice(1).map((s) => {
    const [heading, ...rest] = s.split("\n");
    const m = heading.match(/^## ([\d.]+)\s+(.*)$/);
    if (!m) throw new Error(`unnumbered section "${heading}"`);
    return { number: m[1], title: m[2].trim(), body: rest.join("\n").trim() };
  });
  return { meta, title, sections };
}

// Finds the history version for a doc_id across data/hcp/history/*.json.
export function historyFor(docId, histories) {
  for (const h of histories) {
    const v = h.versions.find((x) => x.doc_id === docId);
    if (v) return { setid: h.setid, version: v.version };
  }
  return null;
}

export function renderSpl(text, histories) {
  const { meta, title, sections } = parseLabel(text);
  const hist = historyFor(meta.doc_id, histories);
  if (!hist) throw new Error(`${meta.doc_id}: no version in data/hcp/history`);
  const date = meta.effective_date.replace(/-/g, "");
  const out = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<document xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`,
    `  <id root="${uuid(`${meta.doc_id}:document`)}"/>`,
    `  <code code="${DOCUMENT[0]}" codeSystem="2.16.840.1.113883.6.1" displayName="${esc(DOCUMENT[1])}"/>`,
    `  <title>${inline(title)}</title>`,
    `  <effectiveTime value="${date}"/>`,
    `  <setId root="${hist.setid}"/>`,
    `  <versionNumber value="${hist.version}"/>`,
    `  <component>`,
    `    <structuredBody>`,
  ];
  // Group "## 5.1", "## 5.2" under one top-level section 5, as SPL nests them.
  const groups = [];
  for (const s of sections) {
    const top = Number(s.number.split(".")[0]);
    if (!LOINC[top]) throw new Error(`${meta.doc_id}: section ${s.number} has no LOINC code`);
    let g = groups.at(-1);
    if (!g || g.top !== top) groups.push((g = { top, own: null, subs: [] }));
    if (!s.number.includes(".") || s.number === "0.0") g.own = s;
    else g.subs.push(s);
  }
  for (const g of groups) {
    const [code, name] = LOINC[g.top];
    const head = g.own ?? { number: String(g.top), title: name, body: "" };
    out.push(
      `      <component>`,
      `        <section ID="s${head.number.replace(".", "-")}">`,
      `          <id root="${uuid(`${meta.doc_id}:${head.number}`)}"/>`,
      `          <code code="${code}" codeSystem="2.16.840.1.113883.6.1" displayName="${esc(name)}"/>`,
      `          <title>${inline(`${head.number} ${head.title}`)}</title>`,
    );
    if (head.body) out.push(`          <text>`, ...narrative(head.body, "            "), `          </text>`);
    out.push(`          <effectiveTime value="${date}"/>`);
    for (const s of g.subs) {
      out.push(
        `          <component>`,
        `            <section ID="s${s.number.replace(/\./g, "-")}">`,
        `              <id root="${uuid(`${meta.doc_id}:${s.number}`)}"/>`,
        `              <code code="${SUBSECTION[0]}" codeSystem="2.16.840.1.113883.6.1" displayName="${esc(SUBSECTION[1])}"/>`,
        `              <title>${inline(`${s.number} ${s.title}`)}</title>`,
        `              <text>`,
        ...narrative(s.body, "                "),
        `              </text>`,
        `              <effectiveTime value="${date}"/>`,
        `            </section>`,
        `          </component>`,
      );
    }
    out.push(`        </section>`, `      </component>`);
  }
  out.push(`    </structuredBody>`, `  </component>`, `</document>`, "");
  return out.join("\n");
}

// The words a reader sees, for proving the XML carries every word of the markdown.
const squash = (s) => s.split(/\s+/).filter(Boolean).join(" ");
export const mdWords = (md) =>
  squash(md.replace(/\*\*/g, "").replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1$2").replace(/^\s*(-|\d+\.)\s/gm, " ")
    .replace(/^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-*:?\s*$/gm, " ").replace(/\|/g, " "));
export const xmlWords = (xml) =>
  squash(xml.replace(/<\/?content[^>]*>/g, "").replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&"));

export const loadHistories = () => {
  const dir = join(root, "data/hcp/history");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"))) : [];
};

// The contract check-dataset.mjs runs. Returns one line per problem.
export function checkSpl() {
  const problems = [];
  const fail = (m) => problems.push(m);
  const histories = loadHistories();
  const labels = new Map(); // doc_id -> { file, text, meta, sections }
  for (const f of readdirSync(join(root, "data/hcp/labels")).filter((x) => x.endsWith(".md")).sort()) {
    const text = readFileSync(join(root, "data/hcp/labels", f), "utf8");
    const parsed = parseLabel(text);
    labels.set(parsed.meta.doc_id, { file: f, text, ...parsed });
  }
  // History: one set id per label family, versions 1..n, each matching its label's frontmatter,
  // and a change list that names exactly the sections that differ from the previous version.
  const seen = new Set();
  for (const h of histories) {
    const name = `history ${h.setid}`;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(h.setid ?? "")) fail(`${name}: setid is not a lowercase UUID v4`);
    for (const k of ["title", "tenant_id", "country"]) if (!h[k]) fail(`${name}: lacks ${k}`);
    (h.versions ?? []).forEach((v, i) => {
      if (v.version !== i + 1) fail(`${name}: version ${i + 1} is numbered ${v.version}`);
      const label = labels.get(v.doc_id);
      if (!label) return fail(`${name}: ${v.doc_id} has no file in data/hcp/labels`);
      if (seen.has(v.doc_id)) fail(`${name}: ${v.doc_id} is in two histories`);
      seen.add(v.doc_id);
      for (const k of ["effective_date", "status", "tenant_id", "country"]) {
        const want = k in v ? v[k] : h[k];
        if (want !== label.meta[k]) fail(`${name}: ${v.doc_id} ${k} is "${want}", its label says "${label.meta[k]}"`);
      }
      if (i === 0) { if ((v.changes ?? []).length) fail(`${name}: version 1 lists changes`); return; }
      const prev = labels.get(h.versions[i - 1].doc_id);
      if (!prev) return;
      const body = (l) => new Map(l.sections.map((s) => [s.number, `${s.title}\n${s.body}`]));
      const [a, b] = [body(prev), body(label)];
      const differ = [...new Set([...a.keys(), ...b.keys()])].filter((n) => a.get(n) !== b.get(n)).sort();
      const listed = [...new Set((v.changes ?? []).map((c) => c.section))].sort();
      for (const c of v.changes ?? []) if (!c.summary?.trim()) fail(`${name}: ${v.doc_id} change ${c.section} has no summary`);
      for (const n of differ) if (!listed.includes(n)) fail(`${name}: ${v.doc_id} section ${n} differs from version ${i} but is not in changes`);
      for (const n of listed) if (!differ.includes(n)) fail(`${name}: ${v.doc_id} lists section ${n} as changed, but it is identical to version ${i}`);
    });
  }
  // SPL: every US label has its XML, byte for byte what the renderer writes, carrying every word.
  const splDir = join(root, "data/hcp/spl");
  const written = existsSync(splDir) ? new Set(readdirSync(splDir)) : new Set();
  for (const [docId, label] of labels) {
    if (!isUsLabel(label.text)) continue;
    if (!seen.has(docId)) fail(`labels/${label.file}: a US label needs a version in data/hcp/history`);
    const xmlName = label.file.replace(/\.md$/, ".xml");
    written.delete(xmlName);
    let want;
    try { want = renderSpl(label.text, histories); } catch (e) { fail(`labels/${label.file}: ${e.message}`); continue; }
    const path = join(splDir, xmlName);
    if (!existsSync(path)) { fail(`data/hcp/spl/${xmlName} is missing: run node scripts/spl.mjs`); continue; }
    if (readFileSync(path, "utf8") !== want) fail(`data/hcp/spl/${xmlName} is older than labels/${label.file}: run node scripts/spl.mjs`);
    for (const s of label.sections) {
      const m = want.match(new RegExp(`<section ID="s${s.number.replace(/\./g, "-")}">([\\s\\S]*?)<effectiveTime`));
      const xml = m ? xmlWords(m[1].replace(/<title>[\s\S]*?<\/title>/, "")) : "";
      if (xml !== mdWords(s.body)) fail(`data/hcp/spl/${xmlName}: section ${s.number} does not carry the label's words`);
    }
  }
  for (const stray of written) fail(`data/hcp/spl/${stray} has no US label in data/hcp/labels`);
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const histories = loadHistories();
  mkdirSync(join(root, "data/hcp/spl"), { recursive: true });
  for (const f of readdirSync(join(root, "data/hcp/labels")).filter((x) => x.endsWith(".md")).sort()) {
    const text = readFileSync(join(root, "data/hcp/labels", f), "utf8");
    if (!isUsLabel(text)) continue;
    writeFileSync(join(root, "data/hcp/spl", f.replace(/\.md$/, ".xml")), renderSpl(text, histories));
    console.log(`wrote data/hcp/spl/${f.replace(/\.md$/, ".xml")}`);
  }
}
