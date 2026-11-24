// Structure test for the dataset. Node only, no dependencies, no API key.
// Fails when a doc, a citation, a token or an eval config breaks the contract in README.md.
import { readdirSync, readFileSync } from "node:fs";
import { join, basename, extname } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const problems = [];
const fail = (msg) => problems.push(msg);
const read = (p) => readFileSync(join(root, p), "utf8");
const list = (dir) => readdirSync(join(root, dir)).sort();

// 1. Every HCP doc has the six frontmatter keys. Collect doc_id -> section numbers.
const REQUIRED = ["doc_id", "tenant_id", "brand_id", "status", "effective_date", "country"];
const docs = new Map();
for (const f of list("data/hcp/docs")) {
  const text = read(`data/hcp/docs/${f}`);
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) { fail(`docs/${f}: no frontmatter`); continue; }
  const keys = Object.fromEntries(
    fm[1].split("\n").map((l) => l.match(/^([a-z_]+):\s*(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]),
  );
  for (const k of REQUIRED) if (!keys[k]) fail(`docs/${f}: frontmatter lacks ${k}`);
  const sections = [...text.matchAll(/^#{2,3}\s+([\d.]+)\s/gm)].map((m) => m[1]);
  docs.set(keys.doc_id, sections);
}

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
  chapter: /^(0\d|1\d)$/,
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
      if (meta.showcase !== undefined && !/^(0\d|1\d)$/.test(meta.showcase)) fail(`${c}: case ${id} has metadata.showcase "${meta.showcase}"`);
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

if (problems.length) {
  console.error(problems.map((p) => `FAIL ${p}`).join("\n"));
  process.exit(1);
}
console.log(`ok: ${docs.size} docs, ${configs.length} eval configs`);
