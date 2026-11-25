// Writes the two sales files in data/hcp/sql/ from a fixed seed, so the same command always gives
// the same bytes. check-dataset.mjs runs `salesFiles()` and fails when a file on disk differs.
//
//   node scripts/gen-sales.mjs          # rewrite the two CSVs
//
// The two companies send their data in two shapes on purpose, as two real data vendors would:
// Pharma A sends one row per prescriber per week with the prescriber's NPI, Pharma B one row per
// prescriber per month with the prescriber's email. The NPI and the email exist only to test that
// they never leak. The first rows of each file are the ones the dataset always had, kept word for word.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// mulberry32: a small seeded generator, so no dependency and no randomness between runs.
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TERRITORIES = ["NE-01", "SW-02", "MW-03", "SE-04"];
const PRESCRIBERS = 60;
const WEEKS = 26;
const FIRST_WEEK = "2026-05-25";
const MONTHS = ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"];

// Weekly change in prescribing over the last 12 weeks, per territory. SW-02 grows clearly, SE-04
// falls, so "which territory grew the most" has one answer whichever fair window a query uses.
const WEEKLY_TREND = { "NE-01": 0.01, "SW-02": 0.06, "MW-03": 0.0, "SE-04": -0.03 };
const MONTHLY_TREND = { "NE-01": 0.02, "SW-02": 0.04, "MW-03": 0.12, "SE-04": -0.05 };

// Cells with fewer than 11 prescribers. The BI view must hide them, so a small group can never
// point at one doctor.
export const SMALL_CELLS = {
  pharma_a: [{ territory: "MW-03", week: "2026-06-01", prescribers: 7 }, { territory: "SE-04", week: "2026-06-08", prescribers: 6 }],
  pharma_b: [{ region: "NE-01", month: "2026-07", prescribers: 6 }]
};

const KEPT_A = [
  "2026-09-07,NE-01,brand_cardionex,142,38,1043298112",
  "2026-09-14,NE-01,brand_cardionex,168,44,1982347610",
  "2026-09-21,NE-01,brand_cardionex,195,51,1122334455",
  "2026-09-07,SW-02,brand_cardionex,98,21,1555666777",
  "2026-09-14,SW-02,brand_cardionex,110,29,1666777888"
];
const KEPT_B = [
  "2026-08,SW-02,brand_neurovex,820,2460,dr.patel@southwest-neuro.org",
  "2026-09,SW-02,brand_neurovex,940,2820,dr.gomez@heart-neuro-clinic.org",
  "2026-10,SW-02,brand_neurovex,1105,3315,dr.chen@metro-diabetes.org"
];

const weekOf = (i) => new Date(Date.parse(`${FIRST_WEEK}T00:00:00Z`) + i * 7 * 86_400_000).toISOString().slice(0, 10);
// Growth starts 12 weeks (or 3 months) before the end, so the earlier weeks are flat.
const trendAt = (rate, index, length, recent) => Math.max(0.2, 1 + rate * Math.max(0, index - (length - recent)));
// A count near `mean`: the sum of a few uniform draws, rounded, never below 0.
const countNear = (next, mean) => Math.max(0, Math.round(mean * (0.6 + 0.8 * ((next() + next() + next()) / 3))));

const SURNAMES = ["adams", "baker", "bose", "brown", "cho", "costa", "das", "diaz", "ekker", "farah", "fischer", "garcia", "haas", "ito", "jensen", "kaur", "kim", "lopez", "mehta", "meyer", "moreau", "nagy", "novak", "okafor", "olsen", "park", "ramos", "rossi", "sato", "silva"];
const CLINICS = ["valley-heart", "lakeside-neuro", "north-clinic", "harbor-health", "summit-care", "river-neuro"];

function pharmaA() {
  const next = random(2201);
  const rows = [...KEPT_A];
  for (const territory of TERRITORIES) {
    // Each territory's NPIs come from its own range, so no NPI is in two territories.
    const npis = Array.from({ length: PRESCRIBERS }, (_, i) => String(1_200_000_000 + TERRITORIES.indexOf(territory) * 10_000_000 + i * 104_729 + Math.floor(next() * 1000)));
    const base = npis.map(() => 1 + next() * 7);
    for (let w = 0; w < WEEKS; w++) {
      const week = weekOf(w);
      const small = SMALL_CELLS.pharma_a.find((cell) => cell.territory === territory && cell.week === week);
      const writers = small ? small.prescribers : PRESCRIBERS;
      for (let p = 0; p < writers; p++) {
        const trx = countNear(next, base[p] * trendAt(WEEKLY_TREND[territory], w, WEEKS, 12));
        if (trx === 0) continue;
        const nbrx = Math.min(trx, countNear(next, trx * 0.28));
        rows.push(`${week},${territory},brand_cardionex,${trx},${nbrx},${npis[p]}`);
      }
    }
  }
  return ["week_start,territory_code,brand_code,total_trx,nbrx_count,prescriber_npi", ...rows].join("\n") + "\n";
}

function pharmaB() {
  const next = random(2202);
  const rows = [...KEPT_B];
  for (const region of TERRITORIES) {
    const emails = Array.from({ length: PRESCRIBERS }, (_, i) => `dr.${SURNAMES[i % SURNAMES.length]}${i}.${region.toLowerCase().replace("-", "")}@${CLINICS[Math.floor(next() * CLINICS.length)]}.org`);
    const base = emails.map(() => 10 + next() * 40);
    MONTHS.forEach((month, m) => {
      const small = SMALL_CELLS.pharma_b.find((cell) => cell.region === region && cell.month === month);
      const writers = small ? small.prescribers : PRESCRIBERS;
      for (let p = 0; p < writers; p++) {
        const scripts = countNear(next, base[p] * trendAt(MONTHLY_TREND[region], m, MONTHS.length, 3));
        if (scripts === 0) continue;
        rows.push(`${month},${region},brand_neurovex,${scripts},${scripts * 3},${emails[p]}`);
      }
    });
  }
  return ["dispense_month,region_id,product_slug,scripts_filled,units_shipped,hcp_email", ...rows].join("\n") + "\n";
}

export function salesFiles() {
  return { "data/hcp/sql/pharma_a_territory_rx.csv": pharmaA(), "data/hcp/sql/pharma_b_dispenses.csv": pharmaB() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL("..", import.meta.url).pathname;
  for (const [file, text] of Object.entries(salesFiles())) {
    writeFileSync(root + file, text);
    console.log(`${file}: ${text.trim().split("\n").length - 1} rows`);
  }
}

// The numbers evals/hcp/insights.yaml asserts, worked out from the files themselves, so a change to
// the generator that moves an answer fails check-dataset.mjs instead of a learner's run.
export function salesFacts(files = salesFiles()) {
  const rows = (file) => files[file].trim().split("\n").slice(1).map((line) => line.split(","));
  const sum = (list, pick) => list.reduce((total, row) => total + Number(pick(row)), 0);
  const a = rows("data/hcp/sql/pharma_a_territory_rx.csv");
  const weeks = [...new Set(a.map((row) => row[0]))].sort();
  const nbrx = (territory, list) => sum(a.filter((row) => row[1] === territory && list.includes(row[0])), (row) => row[4]);
  const growthA = TERRITORIES.map((t) => ({ t, last: nbrx(t, weeks.slice(-4)), before: nbrx(t, weeks.slice(-8, -4)) }))
    .sort((x, y) => y.last / y.before - x.last / x.before);
  const b = rows("data/hcp/sql/pharma_b_dispenses.csv");
  const scripts = (region, month) => sum(b.filter((row) => row[1] === region && row[0] === month), (row) => row[3]);
  const growthB = TERRITORIES.map((r) => ({ r, change: scripts(r, "2026-11") / scripts(r, "2026-09") })).sort((x, y) => y.change - x.change);
  const small = SMALL_CELLS.pharma_a[0];
  return {
    "INSIGHTS-01": { territory: growthA[0].t, nbrxLast4: growthA[0].last },
    "INSIGHTS-02": { pharmaBSw02: ["2026-09", "2026-10", "2026-11"].map((m) => scripts("SW-02", m)) },
    "INSIGHTS-05": { trx: sum(a.filter((row) => row[1] === small.territory && row[0] === small.week), (row) => row[3]) },
    "INSIGHTS-06": { region: growthB[0].r }
  };
}
