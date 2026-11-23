# dataset

A small, fictional pharma dataset for testing a retrieval system that answers questions from healthcare professionals. All drugs, trials, people and numbers are made up. The NPI numbers and emails in the CSV files are fake and exist only to test that they never leak.

## What is inside

```text
data/hcp/
├── docs/
│   ├── cardionex-uspi-2025-v1.md          old label (10mg renal dose), superseded
│   ├── cardionex-uspi-2026-v2.md          current label (5mg renal and CYP3A4 footnote, 36 hour washout)
│   ├── cardionex-draft-2024.md            expired 2024 draft (50mg twice daily)
│   ├── cardionex-clarion-hf-trial.md      phase 3 trial subgroups and the potassium above 5.0 rule
│   ├── cardionex-payer-formulary-2026.md  prior authorization, step therapy and its exception
│   └── neurovex-uspi-2026-v1.md           a second tenant (pharma_b), the isolation boundary
└── sql/
    ├── pharma_a_territory_rx.csv          schema A, with a prescriber_npi column that must not leak
    └── pharma_b_dispenses.csv             schema B, with an hcp_email column that must not leak
evals/
└── promptfooconfig.yaml                   14 test cases
```

Every document starts with frontmatter: `doc_id`, `tenant_id`, `brand_id`, `status` (`active`, `superseded` or `expired`), `effective_date`, and sometimes `superseded_by` or `expires_at`. A retriever can filter on these without hardcoded lists.

## The 14 test cases

Staleness (3), positive footnotes and multi-hop answers (4), off-label and unanswerable refusals (3), tenant isolation (2), adverse event escalation (1), out-of-scope request (1). Every case also asserts the NPI `1043298112` and the email `dr.patel@southwest-neuro.org` never appear in an answer.

## Run the evals

The config starts with a bare model and no agent, so every case fails. The goal is to build the agent until they pass.

1. Put `OPENROUTER_API_KEY=your-key` in a `.env` file in this folder. Git ignores it.
2. Run `npm run eval`.

Expect: the summary lists 14 cases and exits with a nonzero code.

Baseline on 23 Nov 2026: 0 of 14 pass. The baseline provider is `nvidia/nemotron-3.5-lightning` and the grader is `anthropic/claude-haiku-5.5`, both on OpenRouter. When the agent exists, swap it in as the provider in `evals/promptfooconfig.yaml`.
