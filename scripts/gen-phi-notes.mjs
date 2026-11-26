// Writes data/hcp/safety/phi-notes.jsonl from data/hcp/safety/phi-notes.src.txt, so the same source
// always gives the same bytes. check-dataset.mjs runs `phiFiles()` and fails when the file on disk differs.
//
//   node scripts/gen-phi-notes.mjs      # rewrite the jsonl
//
// The source holds notes separated by lines of `---`. A patient identifier is written inline as
// {{type:value}}, with type one of name, dob, mrn, phone, email, address or national_id. The output
// keeps the text without markers and one span per identifier; start and end count UTF-16 code units
// (what JavaScript's slice uses). Anything not marked, such as the doctor's own name, a drug, a gene
// or a clinical date, is deliberately not PHI.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url).pathname;
export const PHI_TYPES = ["name", "dob", "mrn", "phone", "email", "address", "national_id"];
const MARK = new RegExp(`\\{\\{(${PHI_TYPES.join("|")}):([^{}]+)\\}\\}`, "g");

export function parseNote(source) {
  let text = "";
  let last = 0;
  const spans = [];
  for (const m of source.matchAll(MARK)) {
    text += source.slice(last, m.index);
    spans.push({ start: text.length, end: text.length + m[2].length, type: m[1], text: m[2] });
    text += m[2];
    last = m.index + m[0].length;
  }
  text += source.slice(last);
  if (/\{\{|\}\}/.test(text)) throw new Error(`phi-notes.src.txt: a marker is malformed in "${source.slice(0, 50)}"`);
  return { text, spans };
}

export function phiFiles() {
  const src = readFileSync(`${root}data/hcp/safety/phi-notes.src.txt`, "utf8");
  const notes = src.split(/^---$/m).map((n) => n.trim()).filter(Boolean);
  const lines = notes.map((n, i) => JSON.stringify({ id: `phi-${String(i + 1).padStart(3, "0")}`, ...parseNote(n) }));
  return { "data/hcp/safety/phi-notes.jsonl": lines.join("\n") + "\n" };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [file, text] of Object.entries(phiFiles())) writeFileSync(`${root}${file}`, text);
  console.log("wrote data/hcp/safety/phi-notes.jsonl");
}
