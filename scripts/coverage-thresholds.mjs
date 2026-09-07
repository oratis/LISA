// Per-target coverage floors, checked against coverage/coverage-summary.json.
//
// c8's own --check-coverage is all-or-nothing (one global threshold, or
// --per-file which applies the same number to every file). Neither fits here:
// the repo sits at ~74% lines overall and lifting that to 85% is a long
// project, but the modules that decide money, identity and Soul state must not
// regress. So this checks a small table of security- and billing-critical
// paths instead, seeded at min(85, measured) rounded down — a ratchet that is
// green today and only ever moves up.
//
// Raise a floor whenever real coverage passes it. Never lower one to make a
// build pass: a drop means a test stopped covering a path that handles money,
// auth or Soul writes.
//
// Also emits a GitHub step summary table when $GITHUB_STEP_SUMMARY is set.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Measured on 2026-09-06 (1,645 tests). A trailing "/" means "every file under
 * this directory, aggregated"; anything else is a single file.
 */
const TARGETS = [
  // path,                      lines, branches, functions   // measured
  ["src/billing/", 84, 80, 85], // 84.89 / 80.49 / 90.91
  ["src/web/accounts.ts", 85, 85, 85], // 94.50 / 89.55 / 97.44
  ["src/web/otp.ts", 85, 80, 85], // 94.55 / 80.77 / 100.00
  ["src/web/sessions-auth.ts", 85, 78, 85], // 95.56 / 78.79 / 100.00
  ["src/web/capabilities.ts", 85, 85, 85], // 100.00 / 92.31 / 100.00
  ["src/soul/store.ts", 78, 85, 67], // 78.17 / 85.88 / 67.86
];

const summaryPath = path.join(root, "coverage", "coverage-summary.json");
if (!fs.existsSync(summaryPath)) {
  console.error(
    `coverage-thresholds: ${path.relative(root, summaryPath)} not found — run \`npm run test:coverage\``,
  );
  process.exit(1);
}
const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));

/** c8 keys files by absolute path; compare on repo-relative POSIX paths. */
function relKey(key) {
  const rel = path.isAbsolute(key) ? path.relative(root, key) : key;
  return rel.split(path.sep).join("/");
}

const METRICS = ["lines", "branches", "functions"];

function measure(target) {
  const isDir = target.endsWith("/");
  const totals = Object.fromEntries(METRICS.map((m) => [m, { covered: 0, total: 0 }]));
  let files = 0;
  for (const [key, entry] of Object.entries(summary)) {
    if (key === "total") continue;
    const rel = relKey(key);
    if (isDir ? !rel.startsWith(target) : rel !== target) continue;
    files++;
    for (const m of METRICS) {
      totals[m].covered += entry[m].covered;
      totals[m].total += entry[m].total;
    }
  }
  return { files, totals };
}

// A metric with nothing to cover (total 0) is vacuously 100%; treating it as 0
// would fail the build on, say, a file with no branches.
const pct = ({ covered, total }) => (total === 0 ? 100 : (covered / total) * 100);

const rows = [];
const failures = [];
for (const [target, ...floors] of TARGETS) {
  const { files, totals } = measure(target);
  if (files === 0) {
    // A renamed or deleted target would otherwise pass silently forever.
    failures.push(`${target}: no coverage entries — was it renamed or excluded?`);
    rows.push({ target, files, cells: METRICS.map(() => "—"), ok: false });
    continue;
  }
  const cells = [];
  let ok = true;
  METRICS.forEach((m, i) => {
    const value = pct(totals[m]);
    const floor = floors[i];
    if (value + 1e-9 < floor) {
      ok = false;
      failures.push(`${target} ${m} ${value.toFixed(2)}% < ${floor}% floor`);
    }
    cells.push(`${value.toFixed(2)}% / ${floor}%`);
  });
  rows.push({ target, files, cells, ok });
}

const overall = METRICS.map((m) => `${m} ${pct(summary.total[m]).toFixed(2)}%`).join(" · ");
const header = ["Path", ...METRICS.map((m) => `${m} (actual / floor)`), ""];
const table = [
  `| ${header.join(" | ")} |`,
  `|${header.map(() => " --- ").join("|")}|`,
  ...rows.map((r) => `| \`${r.target}\` | ${r.cells.join(" | ")} | ${r.ok ? "ok" : "FAIL"} |`),
];

console.log(`\nCritical-module coverage floors (repo total: ${overall})`);
console.log(table.join("\n"));

if (process.env.GITHUB_STEP_SUMMARY) {
  const md = [
    "### Coverage",
    "",
    `Repo total: **${overall}**`,
    "",
    ...table,
    "",
    failures.length
      ? `**${failures.length} floor(s) breached.**`
      : "All critical-module floors met.",
    "",
  ].join("\n");
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}

if (failures.length) {
  for (const f of failures) console.error(`::error ::coverage floor breached — ${f}`);
  console.error(
    "\nThese paths handle money, auth or Soul writes. Add tests rather than lowering the floor in scripts/coverage-thresholds.mjs.",
  );
  process.exit(1);
}
console.log("All critical-module coverage floors met.\n");
