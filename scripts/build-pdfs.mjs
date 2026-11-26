// Prints each HCP document as the PDF a company would actually receive: a two-column leaflet.
// Maintainers only: needs pandoc and weasyprint on the PATH. The PDFs are committed, so a learner
// never runs this. The text comes from data/hcp/labels/<file>.md when the full label is there,
// otherwise from data/hcp/docs/<file>.md. data/hcp/pdf/manifest.json records each document's
// frontmatter and the sha256 of its source, and check-dataset.mjs fails when a source changed
// after its PDF was printed.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), "hcp-pdf-"));
const css = join(root, "scripts/label.css");
const docs = [];
for (const file of readdirSync(join(root, "data/hcp/docs")).filter((f) => f.endsWith(".md")).sort()) {
  const full = join(root, "data/hcp/labels", file);
  const source = existsSync(full) ? `data/hcp/labels/${file}` : `data/hcp/docs/${file}`;
  const text = readFileSync(join(root, source), "utf8");
  const [, front, body] = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const meta = Object.fromEntries(
    front.split("\n").map((l) => l.match(/^([a-z_]+):\s*(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]),
  );
  const pdf = `data/hcp/pdf/${file.replace(/\.md$/, ".pdf")}`;
  const stamp = `Document ${meta.doc_id} · ${meta.country} · effective ${meta.effective_date} · status ${meta.status}`;
  const md = join(work, file);
  const lines = body.split("\n");
  const title = lines.findIndex((l) => l.startsWith("# "));
  lines.splice(title + 1, 0, "", `<div class="meta">${stamp}</div>`);
  writeFileSync(md, lines.join("\n"));
  const html = join(work, file.replace(/\.md$/, ".html"));
  execFileSync("pandoc", [md, "-f", "gfm", "-t", "html5", "-s", "--metadata", `pagetitle=${meta.doc_id}`, "-o", html]);
  // PDF/UA-1 tags each heading, paragraph and table cell, as a label PDF made for screen
  // readers is. A reader then takes the text in the order it was written, not from positions.
  execFileSync("weasyprint", ["--pdf-variant", "pdf/ua-1", "-s", css, html, join(root, pdf)]);
  docs.push({ ...meta, pdf, source, sha256: createHash("sha256").update(text).digest("hex") });
  console.log(`printed ${pdf}`);
}
writeFileSync(join(root, "data/hcp/pdf/manifest.json"), JSON.stringify({ docs }, null, 2) + "\n");
