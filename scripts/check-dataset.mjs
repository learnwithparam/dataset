// Structure test for the dataset. Node only, no dependencies, no API key.
// Fails when a doc, a citation, a token or an eval config breaks the contract in README.md.
import { readdirSync, readFileSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { createHash } from "node:crypto";
import { salesFacts, salesFiles } from "./gen-sales.mjs";
import { checkSpl } from "./spl.mjs";
import { phiFiles, PHI_TYPES } from "./gen-phi-notes.mjs";

const root = new URL("..", import.meta.url).pathname;
const problems = [];
const fail = (msg) => problems.push(msg);
const read = (p) => readFileSync(join(root, p), "utf8");
const list = (dir) => readdirSync(join(root, dir)).sort();

// 1. Every HCP doc has the six frontmatter keys. Collect doc_id -> section numbers.
const REQUIRED = ["doc_id", "tenant_id", "brand_id", "status", "effective_date", "country"];
const docs = new Map();
const labelSources = list("data/hcp/labels");
for (const f of list("data/hcp/docs")) {
  const text = read(`data/hcp/docs/${f}`);
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) { fail(`docs/${f}: no frontmatter`); continue; }
  const keys = Object.fromEntries(
    fm[1].split("\n").map((l) => l.match(/^([a-z_]+):\s*(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]),
  );
  for (const k of REQUIRED) if (!keys[k]) fail(`docs/${f}: frontmatter lacks ${k}`);
  const sections = [...text.matchAll(/^#{2,3}\s+([\d.]+)\s/gm)].map((m) => m[1]);
  // A full label in data/hcp/labels/ adds sections the excerpt leaves out; a case may cite them.
  const full = labelSources.includes(f) ? read(`data/hcp/labels/${f}`) : "";
  docs.set(keys.doc_id, [...sections, ...[...full.matchAll(/^#{2,3}\s+([\d.]+)\s/gm)].map((m) => m[1])]);
  checkFullLabel(f, text, full);
}

// 1b. The PDFs (data/hcp/pdf) are what a company really receives. Each doc has one, printed
//     from its current source (the sha256 in the manifest), and a full label keeps every
//     section of its excerpt word for word, so the two never tell a doctor different things.
function checkFullLabel(f, excerpt, full) {
  if (!full) return;
  const body = (t) => t.replace(/^---\n[\s\S]*?\n---\n/, "");
  const fullSections = new Map(body(full).split(/^(?=## )/m).map((s) => [s.split("\n")[0], s.trim()]));
  for (const section of body(excerpt).split(/^(?=## )/m).filter((s) => s.startsWith("## "))) {
    if (fullSections.get(section.split("\n")[0]) !== section.trim()) fail(`labels/${f}: section "${section.split("\n")[0]}" differs from docs/${f}`);
  }
  if (excerpt.match(/^---\n[\s\S]*?\n---/)[0] !== full.match(/^---\n[\s\S]*?\n---/)?.[0]) fail(`labels/${f}: frontmatter differs from docs/${f}`);
}
const manifest = JSON.parse(read("data/hcp/pdf/manifest.json")).docs;
const pdfs = new Set(list("data/hcp/pdf").filter((f) => f.endsWith(".pdf")));
for (const f of list("data/hcp/docs")) {
  const entry = manifest.find((d) => d.pdf === `data/hcp/pdf/${f.replace(/\.md$/, ".pdf")}`);
  if (!entry) { fail(`pdf/manifest.json: no PDF for docs/${f}`); continue; }
  if (!pdfs.has(basename(entry.pdf))) fail(`${entry.pdf} is missing`);
  const source = labelSources.includes(f) ? `data/hcp/labels/${f}` : `data/hcp/docs/${f}`;
  if (entry.source !== source) fail(`${entry.pdf} was printed from ${entry.source}, expected ${source}`);
  else if (entry.sha256 !== createHash("sha256").update(read(source)).digest("hex")) fail(`${entry.pdf} is older than ${source}: run node scripts/build-pdfs.mjs`);
}
if (manifest.length !== list("data/hcp/docs").length) fail("pdf/manifest.json lists a doc that is not in data/hcp/docs");

// 2. Record files: a citation [file, id] needs a data file named like `file` that holds the id.
const recordFiles = new Map();
for (const dir of ["data/hcp/crm", "data/hcp/content", "data/hcp/sql", "data/hcp/events", "data/teammates"]) {
  for (const f of list(dir)) {
    const key = basename(f, extname(f)).replace(/_/g, "-");
    recordFiles.set(key, read(`${dir}/${f}`));
  }
}

// 3. Tokens listed in README under "## Tokens" (backticked).
const readme = read("README.md");
const tokenSection = readme.split(/^## Tokens\s*$/m)[1]?.split(/^## /m)[0] ?? "";
const allowed = new Set([...tokenSection.matchAll(/`([A-Z][A-Z_]+(?::<bot>)?)`/g)].map((m) => m[1]));
if (allowed.size === 0) fail("README.md has no '## Tokens' section with backticked tokens");

// 4. Walk every eval config.
const METADATA = {
  slice: /^[a-z][a-z0-9-]+$/,
  chapter: /^[012]\d$/,
  riskTier: /^(answer|review|safety|stop)$/,
  split: /^(train|holdout)$/,
  expectedBehavior: /^(reply|ask_follow_up|defer_question)$/,
};
const TEXT_ASSERT = /type: (contains|not-contains|regex|not-regex)\n\s+value: ("(?:[^"\\]|\\.)*")/g;
const caseIds = new Set();
const configs = [];
for (const dir of ["evals/hcp", "evals/teammates"]) {
  for (const f of list(dir)) if (f.endsWith(".yaml")) configs.push(`${dir}/${f}`);
}
for (const c of configs) {
  const text = read(c);
  const [head, ...rest] = text.split(/^tests:\s*$/m);
  const body = rest.join("tests:");
  const leak = c.startsWith("evals/hcp") ? "1043298112" : "4111111111111111";
  if (!/tenantId:/.test(head) || !/brandId:/.test(head)) fail(`${c}: defaultTest lacks tenantId or brandId`);
  if (!head.includes(`value: "${leak}"`)) fail(`${c}: defaultTest lacks the leak assert for ${leak}`);
  if (!/anthropic\/claude-haiku-5\.5/.test(head)) fail(`${c}: grader provider missing`);

  const cases = body.split(/^  - description:/m).slice(1);
  if (cases.length === 0) fail(`${c}: no cases`);
  for (const cs of cases) {
    const name = cs.split("\n")[0].trim().slice(0, 40);
    if (/vars:[\s\S]*tenantId/.test(cs.split("assert:")[0]) === false && !/tenantId:/.test(head)) fail(`${c}: case ${name} lacks tenantId`);

    // HCP cases carry the metadata block the README lists.
    if (c.startsWith("evals/hcp")) {
      const id = cs.match(/^\s*"\[([A-Z0-9-]+)\]/)?.[1];
      if (!id) fail(`${c}: case ${name} has no [ID] in its description`);
      else if (caseIds.has(id)) fail(`${c}: case id ${id} is used twice`);
      else caseIds.add(id);
      const meta = Object.fromEntries(
        [...(cs.split(/^    (?:vars|assert):/m)[0].split(/^    metadata:\s*$/m)[1] ?? "").matchAll(/^      (\w+): (.*)$/gm)]
          .map((m) => [m[1], JSON.parse(m[2])]),
      );
      for (const [key, allowedValues] of Object.entries(METADATA)) {
        const value = meta[key];
        if (value === undefined) fail(`${c}: case ${id ?? name} lacks metadata.${key}`);
        else if (!allowedValues.test(value)) fail(`${c}: case ${id ?? name} has metadata.${key} "${value}"`);
      }
      if (meta.showcase !== undefined && !/^[012]\d$/.test(meta.showcase)) fail(`${c}: case ${id} has metadata.showcase "${meta.showcase}"`);
      if (c.endsWith("medinfo.yaml") && !meta.idealAnswer) fail(`${c}: case ${id ?? name} lacks metadata.idealAnswer`);
    }

    // 5. The ideal answer passes the case's own text checks, tokens aside. An ideal answer
    //    that breaks them teaches the judge one thing and the checks another.
    const ideal = cs.match(/^      idealAnswer: ("(?:[^"\\]|\\.)*")$/m)?.[1];
    if (ideal) {
      const answer = JSON.parse(ideal);
      const asserts = [...head.matchAll(TEXT_ASSERT), ...cs.matchAll(TEXT_ASSERT)].map((m) => [m[1], JSON.parse(m[2])]);
      for (const [type, value] of asserts) {
        if (/^[A-Z][A-Z_]+(:[a-z-]+)?$/.test(value)) continue;
        const ok = {
          contains: () => answer.includes(value),
          "not-contains": () => !answer.includes(value),
          regex: () => new RegExp(value).test(answer),
          "not-regex": () => !new RegExp(value).test(answer),
        }[type]();
        if (!ok) fail(`${c}: case ${name} idealAnswer fails its own ${type} "${value}"`);
      }
    }

    // Tokens inside contains / not-contains.
    for (const m of cs.matchAll(/type: (?:not-)?contains\n\s+value: "([^"]+)"/g)) {
      const v = m[1];
      if (/^[A-Z][A-Z_]+(:[a-z-]+)?$/.test(v)) {
        const key = v.includes(":") ? `${v.split(":")[0]}:<bot>` : v;
        if (!allowed.has(key)) fail(`${c}: token ${v} is not in the README token list`);
      }
    }

    // Citations written as regex: \\[file,\\s*id
    const plain = cs.replace(/\\/g, "");
    for (const m of plain.matchAll(/\[([\w-]+),s\*([\w.-]+)/g)) {
      const [, rawFile, id] = m;
      const file = docs.has(rawFile) ? rawFile : rawFile.replace(/_/g, "-");
      if (docs.has(file)) {
        if (!docs.get(file).some((s) => s.startsWith(id))) fail(`${c}: [${file}, ${id}] has no such section`);
      } else if (recordFiles.has(file)) {
        if (!recordFiles.get(file).includes(id)) fail(`${c}: [${file}, ${id}] has no such record`);
      } else {
        fail(`${c}: citation file ${file} is neither a doc_id nor a data file`);
      }
    }
  }
}

// 6. The sales files are the generator's output, byte for byte, and every number insights.yaml
//    asserts is the number the files give. Hand edits to the CSVs, or a generator change that moves
//    an answer, fail here.
for (const [file, text] of Object.entries(salesFiles())) {
  if (read(file) !== text) fail(`${file} differs from scripts/gen-sales.mjs: run node scripts/gen-sales.mjs`);
}
{
  const facts = salesFacts();
  const insights = read("evals/hcp/insights.yaml");
  const caseText = (id) => insights.split(/^  - description:/m).find((c) => c.includes(`[${id}]`)) ?? "";
  const expect = (id, values) => {
    for (const value of values) if (!caseText(id).includes(String(value))) fail(`evals/hcp/insights.yaml: ${id} should assert ${value}, the number data/hcp/sql gives`);
  };
  expect("INSIGHTS-01", [facts["INSIGHTS-01"].territory, `b${facts["INSIGHTS-01"].nbrxLast4}\\`]);
  expect("INSIGHTS-02", facts["INSIGHTS-02"].pharmaBSw02);
  expect("INSIGHTS-04", [facts["INSIGHTS-02"].pharmaBSw02[1]]);
  expect("INSIGHTS-05", [`b${facts["INSIGHTS-05"].trx} (`]);
  expect("INSIGHTS-06", [facts["INSIGHTS-06"].region]);
}

// 7. Safety data (data/hcp/safety). The dictionary links resolve, every adverse event message is
//    complete and coded with codes the dictionary holds, the counts the lessons rely on hold, and
//    the PHI notes are the generator's output with every span pointing at its own text.
{
  const dict = JSON.parse(read("data/hcp/safety/meddra-synthetic.json"));
  const socs = new Map(), pts = new Map(), llts = new Map();
  const unique = (kind, map, rows, re) => {
    for (const r of rows) {
      if (!re.test(r.code ?? "")) fail(`meddra-synthetic.json: ${kind} code "${r.code}" is not in its fictional range`);
      if (map.has(r.code)) fail(`meddra-synthetic.json: ${kind} code ${r.code} is used twice`);
      map.set(r.code, r);
    }
  };
  unique("soc", socs, dict.soc, /^900\d{5}$/);
  unique("pt", pts, dict.pt, /^91[01]\d{5}$/);
  unique("llt", llts, dict.llt, /^92\d{6}$/);
  for (const p of dict.pt) if (!socs.has(p.soc)) fail(`meddra-synthetic.json: PT ${p.code} points at SOC ${p.soc}, which does not exist`);
  for (const l of dict.llt) if (!pts.has(l.pt)) fail(`meddra-synthetic.json: LLT ${l.code} points at PT ${l.pt}, which does not exist`);
  for (const p of dict.pt) if (!dict.llt.some((l) => l.pt === p.code && l.name === p.name)) fail(`meddra-synthetic.json: PT ${p.code} ${p.name} has no LLT of its own name`);
  if (dict.soc.length < 20 || dict.pt.length < 120 || dict.llt.length < 300) fail(`meddra-synthetic.json: needs at least 20 SOCs, 120 PTs and 300 LLTs, has ${dict.soc.length}, ${dict.pt.length}, ${dict.llt.length}`);

  const FLAGS = { death: "seriousnessdeath", life_threatening: "seriousnesslifethreatening", hospitalization: "seriousnesshospitalization", disabling: "seriousnessdisabling", congenital_anomaly: "seriousnesscongenitalanomali", other_medically_important: "seriousnessother" };
  const SITUATIONS = ["pregnancy_exposure", "overdose", "medication_error", "lack_of_efficacy", "off_label_use"];
  const reports = read("data/hcp/safety/ae-reports.jsonl").trim().split("\n").map((l, i) => {
    try { return JSON.parse(l); } catch { fail(`ae-reports.jsonl line ${i + 1}: not JSON`); return {}; }
  });
  const ids = new Set();
  for (const r of reports) {
    const at = `ae-reports.jsonl ${r.id}`;
    if (!/^ae-\d{3}$/.test(r.id)) fail(`${at}: bad id`);
    if (ids.has(r.id)) fail(`${at}: id used twice`);
    ids.add(r.id);
    if (!["pharma_a", "pharma_b"].includes(r.tenant_id)) fail(`${at}: tenant_id "${r.tenant_id}"`);
    if (!["hcp_chat", "email", "call_center"].includes(r.channel)) fail(`${at}: channel "${r.channel}"`);
    const sentences = (String(r.message).match(/[.?!](\s|$)/g) ?? []).length;
    if (typeof r.message !== "string" || sentences < 1 || sentences > 6) fail(`${at}: message must hold 1 to 6 sentences`);
    for (const k of ["is_adverse_event", "indirect", "serious"]) if (typeof r[k] !== "boolean") fail(`${at}: ${k} must be true or false`);
    if (r.special_situation !== null && !SITUATIONS.includes(r.special_situation)) fail(`${at}: special_situation "${r.special_situation}"`);
    for (const k of ["reporter", "patient", "product", "event"]) if (typeof r.criteria?.[k] !== "boolean") fail(`${at}: criteria.${k} must be true or false`);
    if (!["safety", "answer", "review"].includes(r.expected_route)) fail(`${at}: expected_route "${r.expected_route}"`);
    if ((r.is_adverse_event || r.special_situation) && r.expected_route !== "safety") fail(`${at}: an adverse event or special situation must route to safety`);
    if (!Array.isArray(r.seriousness) || r.seriousness.some((s) => !FLAGS[s])) fail(`${at}: seriousness holds an unknown value`);
    else if (r.serious !== r.seriousness.length > 0) fail(`${at}: serious must be true exactly when seriousness is not empty`);
    if (!Array.isArray(r.meddra)) { fail(`${at}: meddra must be a list`); continue; }
    for (const m of r.meddra) {
      const llt = llts.get(m.llt);
      if (!llt) fail(`${at}: LLT ${m.llt} is not in the dictionary`);
      else if (llt.pt !== m.pt) fail(`${at}: LLT ${m.llt} belongs to PT ${llt.pt}, not ${m.pt}`);
    }
    const hasFaers = r.faers !== null;
    if (hasFaers !== (r.is_adverse_event || r.special_situation !== null)) fail(`${at}: faers must be null exactly when there is no adverse event and no special situation`);
    if (r.is_adverse_event && r.meddra.length === 0) fail(`${at}: an adverse event needs a MedDRA code`);
    if (!r.is_adverse_event && !r.special_situation && r.meddra.length) fail(`${at}: a message without an event holds no MedDRA code`);
    if (!hasFaers) continue;
    const f = r.faers;
    if (!/^2026\d{4}$/.test(f.receivedate ?? "")) fail(`${at}: faers.receivedate`);
    if (!["1", "2"].includes(f.serious) || (f.serious === "1") !== r.serious) fail(`${at}: faers.serious does not match serious`);
    for (const [name, flag] of Object.entries(FLAGS)) if ((f[flag] === "1") !== r.seriousness.includes(name)) fail(`${at}: faers.${flag} does not match seriousness`);
    if (f.primarysource?.qualification !== undefined && !["1", "2", "3", "4", "5"].includes(f.primarysource.qualification)) fail(`${at}: faers.primarysource.qualification`);
    const pat = f.patient ?? {};
    if (pat.patientsex !== undefined && !["0", "1", "2"].includes(pat.patientsex)) fail(`${at}: faers.patient.patientsex`);
    if ((pat.patientonsetage === undefined) !== (pat.patientonsetageunit === undefined) || (pat.patientonsetageunit !== undefined && pat.patientonsetageunit !== "801")) fail(`${at}: faers.patient age and unit (801 is years)`);
    const reactions = pat.reaction ?? [];
    if (reactions.length !== r.meddra.length) fail(`${at}: faers has ${reactions.length} reactions for ${r.meddra.length} MedDRA codes`);
    reactions.forEach((x, i) => {
      const pt = pts.get(r.meddra[i]?.pt);
      if (!pt || x.reactionmeddrapt !== pt.name) fail(`${at}: reactionmeddrapt "${x.reactionmeddrapt}" is not the name of PT ${r.meddra[i]?.pt}`);
      if (!["1", "2", "3", "4", "5", "6"].includes(x.reactionoutcome)) fail(`${at}: reactionoutcome "${x.reactionoutcome}"`);
    });
    const drugs = pat.drug ?? [];
    if (!drugs.length || drugs[0].drugcharacterization !== "1") fail(`${at}: the first drug must be the suspect (drugcharacterization 1)`);
    for (const d of drugs) if (!["1", "2", "3"].includes(d.drugcharacterization) || !d.medicinalproduct) fail(`${at}: a drug lacks a valid drugcharacterization or medicinalproduct`);
  }
  const n = (f) => reports.filter(f).length;
  const counts = [
    ["lines", n(() => true), 64],
    ["adverse events", n((r) => r.is_adverse_event), 44],
    ["indirect adverse events", n((r) => r.is_adverse_event && r.indirect), 16],
    ["adverse events with a missing criterion", n((r) => r.is_adverse_event && !(r.criteria?.reporter && r.criteria?.patient && r.criteria?.product && r.criteria?.event)), 4],
    ["special situations without an adverse event", n((r) => r.special_situation && !r.is_adverse_event), 4],
    ["near misses", n((r) => !r.is_adverse_event && !r.special_situation), 16],
  ];
  for (const [what, have, need] of counts) if (have < need) fail(`ae-reports.jsonl: needs at least ${need} ${what}, has ${have}`);
  for (const k of ["pharma_a", "pharma_b"]) if (!n((r) => r.tenant_id === k)) fail(`ae-reports.jsonl: no line for ${k}`);
  for (const k of ["hcp_chat", "email", "call_center"]) if (!n((r) => r.channel === k)) fail(`ae-reports.jsonl: no line for channel ${k}`);

  for (const [file, text] of Object.entries(phiFiles())) {
    if (read(file) !== text) fail(`${file} differs from scripts/gen-phi-notes.mjs: run node scripts/gen-phi-notes.mjs`);
  }
  const notes = read("data/hcp/safety/phi-notes.jsonl").trim().split("\n").map((l) => JSON.parse(l));
  if (notes.length < 100) fail(`phi-notes.jsonl: needs 100 notes, has ${notes.length}`);
  if (notes.filter((x) => x.spans.length === 0).length < 15) fail("phi-notes.jsonl: needs at least 15 notes with no identifier");
  for (const x of notes) {
    for (const s of x.spans) {
      if (x.text.slice(s.start, s.end) !== s.text) fail(`phi-notes.jsonl ${x.id}: span ${s.start}-${s.end} is not "${s.text}"`);
      if (!PHI_TYPES.includes(s.type)) fail(`phi-notes.jsonl ${x.id}: span type "${s.type}"`);
    }
  }
}

// 8. Label history (DailyMed set-id shape) and the SPL XML of each US label. See scripts/spl.mjs.
for (const p of checkSpl()) fail(p);

// 9. Gold sets (data/hcp/gold): retrieval.jsonl says which sections answer a question, claims.jsonl
//    says whether a quote supports a claim. Every doc and section must exist, and every answer must be in force.
{
  const gdocs = new Map();
  for (const dir of ["docs", "labels"]) {
    for (const f of list(`data/hcp/${dir}`)) {
      const text = read(`data/hcp/${dir}/${f}`);
      const fm = Object.fromEntries(text.match(/^---\n([\s\S]*?)\n---/)[1].split("\n").map((l) => l.match(/^([a-z_]+):\s*(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
      const secs = new Map();
      let cur = null;
      for (const l of text.split("\n")) {
        const h = l.match(/^#{2,3}\s+([\d.]+)\s/);
        if (h) { cur = h[1]; secs.set(cur, l + "\n"); } else if (cur) secs.set(cur, secs.get(cur) + l + "\n");
      }
      if (dir === "labels" || !gdocs.has(fm.doc_id)) gdocs.set(fm.doc_id, { ...fm, text, secs });
    }
  }
  const family = (id) => id.replace(/-v\d+$/, "");
  const live = (s) => s === "active" || s === "approved";
  // In force: active or approved, effective on or before as_of, and not replaced by a later version in force.
  const inForce = (id, asOf) => {
    const d = gdocs.get(id);
    if (!d || !live(d.status) || d.effective_date > asOf) return false;
    if (family(id) === id) return true;
    return ![...gdocs].some(([o, x]) => o !== id && family(o) === family(id) && live(x.status) && x.effective_date <= asOf && x.effective_date > d.effective_date);
  };
  const gold = (name) => {
    const p = `data/hcp/gold/${name}.jsonl`;
    let lines;
    try { lines = read(p).split("\n").filter(Boolean); } catch { fail(`${p}: missing`); return []; }
    return lines.map((l, i) => { try { return JSON.parse(l); } catch { fail(`${p} line ${i + 1}: not JSON`); return null; } }).filter(Boolean);
  };
  const where = (g, x) => `gold/${g} ${x.id}`;
  const secOf = (g, x, doc_id, section) => {
    const d = gdocs.get(doc_id);
    if (!d) { fail(`${where(g, x)}: no doc ${doc_id}`); return null; }
    if (!d.secs.has(section)) { fail(`${where(g, x)}: ${doc_id} has no section ${section}`); return null; }
    if (d.tenant_id !== x.tenant_id) fail(`${where(g, x)}: ${doc_id} belongs to ${d.tenant_id}, not ${x.tenant_id}`);
    return d.secs.get(section);
  };
  const dup = (g, rows) => { const seen = new Set(); for (const x of rows) { if (seen.has(x.id)) fail(`${where(g, x)}: duplicate id`); seen.add(x.id); } };

  const ret = gold("retrieval");
  dup("retrieval", ret);
  const kinds = { direct: 25, paraphrase: 25, follow_up: 20, other_country: 15, phrase: 15, table: 15, cross_doc: 10, version: 10, out_of_label: 20 };
  for (const [k, need] of Object.entries(kinds)) {
    const have = ret.filter((x) => x.kind === k).length;
    if (have < need) fail(`retrieval.jsonl: needs at least ${need} ${k} lines, has ${have}`);
  }
  if (ret.length < 160) fail(`retrieval.jsonl: needs 160 lines, has ${ret.length}`);
  if (ret.filter((x) => x.tenant_id === "pharma_b").length < 30) fail("retrieval.jsonl: needs at least 30 pharma_b lines");
  for (const x of ret) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(x.as_of ?? "")) fail(`${where("retrieval", x)}: as_of`);
    if (!kinds[x.kind]) fail(`${where("retrieval", x)}: kind "${x.kind}"`);
    if (!["pharma_a", "pharma_b"].includes(x.tenant_id)) fail(`${where("retrieval", x)}: tenant_id`);
    if (!x.query || !Array.isArray(x.relevant) || !Array.isArray(x.history)) { fail(`${where("retrieval", x)}: needs query, relevant and history`); continue; }
    if ((x.kind === "out_of_label") !== (x.relevant.length === 0)) fail(`${where("retrieval", x)}: relevant is empty exactly for out_of_label`);
    if (x.kind === "follow_up" && !x.history.length) fail(`${where("retrieval", x)}: follow_up needs history`);
    if (!/^(US|DE|JP)$/.test(x.country ?? "")) fail(`${where("retrieval", x)}: country must be US, DE or JP`);
    if (x.kind === "other_country" && x.country === "US") fail(`${where("retrieval", x)}: other_country needs country DE or JP`);
    if (x.countries && x.kind !== "cross_doc") fail(`${where("retrieval", x)}: countries is only for a cross_doc line`);
    const allowed = x.countries ?? [x.country];
    for (const r of x.relevant) {
      if (secOf("retrieval", x, r.doc_id, r.section) === null) continue;
      const d = gdocs.get(r.doc_id);
      if (![1, 2].includes(r.grade)) fail(`${where("retrieval", x)}: grade of ${r.doc_id} ${r.section}`);
      if (x.kind === "other_country" && d.country !== x.country) fail(`${where("retrieval", x)}: ${r.doc_id} is a ${d.country} doc, the search country is ${x.country}`);
      if (r.grade === 2) {
        if (!inForce(r.doc_id, x.as_of)) fail(`${where("retrieval", x)}: grade-2 ${r.doc_id} is not in force on ${x.as_of}`);
        if (!allowed.includes(d.country)) fail(`${where("retrieval", x)}: grade-2 ${r.doc_id} is ${d.country}, the line is ${allowed.join("/")}`);
      }
    }
  }

  const cl = gold("claims");
  dup("claims", cl);
  const labels = { supported: 35, unsupported: 15, wrong_number: 12, fabricated_quote: 15, wrong_version: 8, wrong_country: 5 };
  for (const [k, need] of Object.entries(labels)) {
    const have = cl.filter((x) => x.label === k).length;
    if (have < need) fail(`claims.jsonl: needs at least ${need} ${k} lines, has ${have}`);
  }
  if (cl.length < 90) fail(`claims.jsonl: needs 90 lines, has ${cl.length}`);
  for (const x of cl) {
    if (!labels[x.label]) { fail(`${where("claims", x)}: label "${x.label}"`); continue; }
    if (!x.claim || !x.quote || !x.as_of) { fail(`${where("claims", x)}: needs claim, quote and as_of`); continue; }
    const text = secOf("claims", x, x.doc_id, x.section);
    if (text === null) continue;
    const d = gdocs.get(x.doc_id);
    if (/[–—]/.test(x.quote + x.claim)) fail(`${where("claims", x)}: dash in claim or quote`);
    if (x.label === "fabricated_quote") {
      if (d.text.toLowerCase().includes(x.quote.toLowerCase())) fail(`${where("claims", x)}: fabricated quote is in ${x.doc_id}`);
      continue;
    }
    if (!text.includes(x.quote)) fail(`${where("claims", x)}: quote is not in ${x.doc_id} ${x.section}`);
    if (x.label === "wrong_version") {
      if (inForce(x.doc_id, x.as_of)) fail(`${where("claims", x)}: wrong_version doc ${x.doc_id} is in force on ${x.as_of}`);
      const cur = [...gdocs.keys()].find((o) => family(o) === family(x.doc_id) && inForce(o, x.as_of));
      if (cur && gdocs.get(cur).text.includes(x.quote)) fail(`${where("claims", x)}: quote is also in the in-force ${cur}`);
    } else if (x.label === "wrong_country") {
      if (!/^(US|DE|JP)$/.test(x.country ?? "")) fail(`${where("claims", x)}: wrong_country needs country`);
      else if (d.country === x.country) fail(`${where("claims", x)}: ${x.doc_id} is a ${x.country} doc`);
      for (const [o, y] of gdocs) if (y.tenant_id === x.tenant_id && y.country === x.country && inForce(o, x.as_of) && y.text.includes(x.quote)) fail(`${where("claims", x)}: quote is also in ${o}`);
    } else if (!inForce(x.doc_id, x.as_of)) fail(`${where("claims", x)}: ${x.label} doc ${x.doc_id} is not in force on ${x.as_of}`);
  }
}

if (problems.length) {
  console.error(problems.map((p) => `FAIL ${p}`).join("\n"));
  process.exit(1);
}
console.log(`ok: ${docs.size} docs, ${configs.length} eval configs`);
