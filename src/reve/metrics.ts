/**
 * Coherence time series for the long-horizon paper: per-UTC-day sums of the
 * drift indicators every dream record already carries. Pure and
 * deterministic: same records + same `now` → byte-identical output.
 */
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
