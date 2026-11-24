/**
 * Coherence time series for the long-horizon paper: per-UTC-day sums of the
 * drift indicators every dream record already carries. Pure and
 * deterministic: same records + same `now` → byte-identical output.
 */
import type { SessionReplay } from "../sessions/replay.js";
import type { DreamMetrics, DreamRecord } from "./types.js";

export const METRIC_KEYS: ReadonlyArray<keyof DreamMetrics> = [
  "identityPatches",
  "purposePatches",
  "constitutionPatches",
  "valuesChurn",
  "opinionsChurn",
  "desireChurn",
  "emotionVolatility",
  "memoryEntriesAdded",
  "memoryEntriesRemoved",
  "kbFilesChanged",
  "skillsTouched",
];

export type MetricsPoint = { date: string; dreams: number } & DreamMetrics;

export interface MetricsSeries {
  days: number;
  from: string;
  to: string;
  series: MetricsPoint[];
  totals: { dreams: number } & DreamMetrics;
}

const DAY = 24 * 60 * 60_000;

function zero(): DreamMetrics {
  const m = {} as DreamMetrics;
  for (const k of METRIC_KEYS) m[k] = 0;
  return m;
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

export function clampDays(raw: unknown, fallback = 30): number {
  const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(365, Math.floor(n));
}

export function metricsSeries(
  records: DreamRecord[],
  opts: { days: number; now: Date },
): MetricsSeries {
  const days = clampDays(opts.days);
  const today = Date.UTC(opts.now.getUTCFullYear(), opts.now.getUTCMonth(), opts.now.getUTCDate());
  const first = today - (days - 1) * DAY;
  const buckets = new Map<string, MetricsPoint>();
  for (let t = first; t <= today; t += DAY) {
    const date = new Date(t).toISOString().slice(0, 10);
    buckets.set(date, { date, dreams: 0, ...zero() });
  }
  const totals = { dreams: 0, ...zero() };
  for (const rec of records) {
    const date = rec.windowStart.slice(0, 10);
    const point = buckets.get(date);
    if (!point) continue;
    point.dreams++;
    totals.dreams++;
    for (const k of METRIC_KEYS) {
      const v = Number(rec.metrics?.[k]) || 0;
      point[k] = round4(point[k] + v);
      totals[k] = round4(totals[k] + v);
    }
  }
  return {
    days,
    from: new Date(first).toISOString().slice(0, 10),
    to: new Date(today).toISOString().slice(0, 10),
    series: [...buckets.values()],
    totals,
  };
}

/** Plain-text rendering for `lisa reve metrics`. */
export function renderMetricsTable(s: MetricsSeries): string {
  const cols: Array<[string, keyof MetricsPoint]> = [
    ["dreams", "dreams"],
    ["ident", "identityPatches"],
    ["purp", "purposePatches"],
    ["const", "constitutionPatches"],
    ["values", "valuesChurn"],
    ["opin", "opinionsChurn"],
    ["desire", "desireChurn"],
    ["emoVol", "emotionVolatility"],
    ["mem+", "memoryEntriesAdded"],
    ["mem-", "memoryEntriesRemoved"],
    ["kb", "kbFilesChanged"],
    ["skills", "skillsTouched"],
  ];
  const header = ["date      ", ...cols.map(([h]) => h.padStart(7))].join(" ");
  const rows = s.series
    .filter((p) => p.dreams > 0)
    .map((p) => [p.date, ...cols.map(([, k]) => String(p[k]).padStart(7))].join(" "));
  const total = [
    "total     ",
    ...cols.map(([, k]) => String((s.totals as MetricsPoint)[k] ?? "").padStart(7)),
  ].join(" ");
  return [
    `Dream coherence metrics ${s.from} → ${s.to} (${s.days} day${s.days === 1 ? "" : "s"})`,
    header,
    ...(rows.length ? rows : ["(no dreams in range)"]),
    total,
  ].join("\n");
}

// ── Offline session-replay persona drift metrics (Harness H3) ────────────

export interface SessionReplayDriftRow {
  sessionId: string;
  startedAt: string;
  turns: number;
  distinctPrompts: number;
  promptRebuilds: number;
  meanPromptDrift: number;
}

export interface ReplayDriftReport {
  sessionsAnalyzed: number;
  sessionsSkippedUnrecorded: number;
  totalTurns: number;
  promptRebuildCount: number;
  uniquePromptFingerprints: number;
  /** Mean line-set Jaccard distance (0 = identical, 1 = disjoint) between consecutive distinct prompts. */
  meanPromptDrift: number;
  perSession: SessionReplayDriftRow[];
}

function lineSet(text: string): Set<string> {
  return new Set(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

function jaccardDistance(a: string, b: string): number {
  const sa = lineSet(a);
  const sb = lineSet(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const line of sa) {
    if (sb.has(line)) inter++;
  }
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : round4(1 - inter / union);
}

/**
 * Compute reproducible offline persona-drift metrics directly from H3
 * `SessionReplay` outputs (docs/PLAN_HARNESS_ALIGNMENT_v1.0.md §4).
 *
 * Pre-H3 sessions (`promptsRecorded === false`) are explicitly dropped and
 * counted in `sessionsSkippedUnrecorded` rather than treated as empty personas.
 */
export function computeReplayDriftMetrics(replays: readonly SessionReplay[]): ReplayDriftReport {
  const sorted = [...replays].sort(
    (a, b) =>
      a.header.startedAt.localeCompare(b.header.startedAt) ||
      a.header.id.localeCompare(b.header.id),
  );

  let sessionsAnalyzed = 0;
  let sessionsSkippedUnrecorded = 0;
  let totalTurns = 0;
  let promptRebuildCount = 0;
  const fingerprints = new Set<string>();
  const allDrifts: number[] = [];
  const perSession: SessionReplayDriftRow[] = [];

  for (const r of sorted) {
    if (!r.promptsRecorded) {
      sessionsSkippedUnrecorded++;
      continue;
    }
    sessionsAnalyzed++;
    totalTurns += r.turns.length;

    const rebuilds = r.promptChanges.filter((c) => c.reason === "rebuilt").length;
    promptRebuildCount += rebuilds;
    for (const c of r.promptChanges) fingerprints.add(c.fingerprint);

    const distinctTexts: string[] = [];
    let lastFp: string | null = null;
    for (const turn of r.turns) {
      if (turn.systemPrompt !== null && turn.promptFingerprint !== lastFp) {
        distinctTexts.push(turn.systemPrompt);
        lastFp = turn.promptFingerprint;
      }
    }
    const sessionDrifts: number[] = [];
    for (let i = 1; i < distinctTexts.length; i++) {
      const d = jaccardDistance(distinctTexts[i - 1]!, distinctTexts[i]!);
      sessionDrifts.push(d);
      allDrifts.push(d);
    }
    const meanSessionDrift =
      sessionDrifts.length > 0
        ? round4(sessionDrifts.reduce((sum, x) => sum + x, 0) / sessionDrifts.length)
        : 0;

    perSession.push({
      sessionId: r.header.id,
      startedAt: r.header.startedAt,
      turns: r.turns.length,
      distinctPrompts: r.promptChanges.length,
      promptRebuilds: rebuilds,
      meanPromptDrift: meanSessionDrift,
    });
  }

  const meanPromptDrift =
    allDrifts.length > 0 ? round4(allDrifts.reduce((sum, x) => sum + x, 0) / allDrifts.length) : 0;

  return {
    sessionsAnalyzed,
    sessionsSkippedUnrecorded,
    totalTurns,
    promptRebuildCount,
    uniquePromptFingerprints: fingerprints.size,
    meanPromptDrift,
    perSession,
  };
}

/** Plain-text summary for `scripts/replay-session.ts --metrics`. */
export function renderReplayDriftReport(report: ReplayDriftReport): string {
  const lines = [
    `Offline replay drift metrics (${report.sessionsAnalyzed} analyzed, ${report.sessionsSkippedUnrecorded} skipped pre-H3)`,
    `turns: ${report.totalTurns} · rebuilds: ${report.promptRebuildCount} · unique prompts: ${report.uniquePromptFingerprints} · mean drift: ${report.meanPromptDrift}`,
  ];
  if (report.perSession.length === 0) {
    lines.push("(no H3 v2 sessions with recorded prompts)");
  } else {
    lines.push("session                  turns  prompts  rebuilds   drift");
    for (const row of report.perSession) {
      lines.push(
        `${row.sessionId.padEnd(24)} ${String(row.turns).padStart(5)}  ${String(row.distinctPrompts).padStart(7)}  ${String(row.promptRebuilds).padStart(8)}  ${String(row.meanPromptDrift).padStart(6)}`,
      );
    }
  }
  return lines.join("\n");
}
