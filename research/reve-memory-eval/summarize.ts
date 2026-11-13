import fs from "node:fs/promises";
import { cases } from "./cases.js";

// Regrade every saved run with ONE final rubric. The raw run files are immutable;
// early `passed` fields used a stricter old-value regex and missed added qualifiers.
interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
interface Sample {
  case: string;
  arm: string;
  repetition: number;
  after: string;
  other?: string;
  error?: unknown;
  result?: { malformed?: boolean };
  calls: number;
  usage: Usage;
}
interface SavedRun {
  model: string;
  results: Sample[];
}
const groups = [
  { label: "baseline", file: "initial", arm: "baseline" },
  { label: "first-optimization", file: "initial", arm: "current" },
  { label: "intermediate-fix", file: "refined", arm: "current" },
  { label: "final", file: "final", arm: "current" },
];
const summary = [];
for (const group of groups) {
  const raw: SavedRun = JSON.parse(
    await fs.readFile(new URL(`./results/${group.file}.json`, import.meta.url), "utf8"),
  );
  const rows = raw.results
    .filter((r) => r.arm === group.arm)
    .map((r) => {
      const fixture = cases.find((c) => c.id === r.case);
      if (!fixture) throw new Error(`Unknown case in saved results: ${r.case}`);
      const all = r.after + "\n" + (r.other ?? "");
      const missing = fixture.required.filter((p) => !p.test(r.after)).map(String);
      const forbidden = fixture.forbidden.filter((p) => p.test(all)).map(String);
      // Additional claims found by manual review of every saved memory output.
      // Distinguish unsupported NEW claims from stale pre-existing facts.
      const unsupportedClaims: string[] = [];
      if (
        r.case === "language-correction" &&
        /Simplified|Traditional|Mandarin|简体|繁体|普通话/i.test(all)
      )
        unsupportedClaims.push("inferred language variant");
      if (r.case === "cancelled-reminder" && /User is (?:a )?vegetarian/i.test(all))
        unsupportedClaims.push("meal preference promoted to identity");
      if (fixture.category === "grounding" && forbidden.length)
        unsupportedClaims.push(...forbidden);
      return {
        case: r.case,
        repetition: r.repetition,
        category: fixture.category,
        passed: !r.error && !missing.length && !forbidden.length && !unsupportedClaims.length,
        missing,
        forbidden,
        unsupportedClaims,
        calls: r.calls,
        malformed: !!r.result?.malformed,
        usage: r.usage,
      };
    });
  const totals = rows.reduce(
    (sum, r) => ({
      inputTokens: sum.inputTokens + r.usage.inputTokens,
      outputTokens: sum.outputTokens + r.usage.outputTokens,
      cacheReadTokens: sum.cacheReadTokens + r.usage.cacheReadTokens,
      cacheWriteTokens: sum.cacheWriteTokens + r.usage.cacheWriteTokens,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  );
  const totalInput = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
  const count = (category: string) => ({
    passed: rows.filter((r) => r.category === category && r.passed).length,
    total: rows.filter((r) => r.category === category).length,
  });
  summary.push({
    label: group.label,
    model: raw.model,
    trials: rows.length,
    passed: rows.filter((r) => r.passed).length,
    correction: count("correction"),
    grounding: count("grounding"),
    retention: count("retention"),
    unsupportedWriteTrials: rows.filter((r) => r.unsupportedClaims.length).length,
    malformed: rows.filter((r) => r.malformed).length,
    calls: rows.reduce((s, r) => s + r.calls, 0),
    tokens: {
      ...totals,
      totalInput,
      total: totalInput + totals.outputTokens,
      meanTotal: (totalInput + totals.outputTokens) / rows.length,
    },
    rows,
  });
}
await fs.writeFile(
  new URL("./results/summary.json", import.meta.url),
  JSON.stringify(
    {
      rubric:
        "Final fixture checks plus manual unsupported-claim audit; all saved arms regraded identically",
      summary,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify(
    summary.map(({ rows, ...rest }) => rest),
    null,
    2,
  ),
);
