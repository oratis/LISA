/**
 * Autonomy run ledger (PLAN_REVE_v1.0 R2).
 *
 * Every self-driven run — idle reflection (Reve), heartbeat tasks, desire pursuits, the
 * weekly examen, end-of-session reflection — appends one structured record
 * here. Before this, autonomy was a black box: idle/heartbeat logged their
 * final text and a `silent` boolean, so you couldn't tell "did real work" from
 * "said (no update) but actually failed to run". This ledger makes outcome,
 * cost, and cadence observable (see `lisa autonomy`).
 *
 * Storage: append-only JSONL at ~/.lisa/autonomy/runs.jsonl, bounded to the
 * last MAX_RUNS lines so it can't grow without limit. Append of a single small
 * line is atomic on POSIX (O_APPEND); the trim runs opportunistically under a
 * cross-process lock.
 */
import path from "node:path";
import { LISA_HOME } from "../paths.js";
import { appendLine, atomicWrite, readTextOrEmpty } from "../fs-utils.js";
import { withFileLock } from "../soul/lock.js";

export const AUTONOMY_DIR = path.join(LISA_HOME, "autonomy");
const RUNS_FILE = path.join(AUTONOMY_DIR, "runs.jsonl");
const RUNS_LOCK = path.join(AUTONOMY_DIR, "runs.lock");
const MAX_RUNS = 2000;

/** Which self-driven mechanism produced the run. */
export type AutonomyKind = "idle" | "heartbeat" | "examen" | "desire" | "reflect";

/**
 * What actually happened — replaces the old silent/non-silent binary.
 * - "done"       — produced a user-facing result / made real progress
 * - "no-update"  — ran fine, nothing worth surfacing (internal-only)
 * - "blocked"    — stopped early by a guard (e.g. token budget breaker)
 * - "error"      — threw / produced unusable output
 */
export type AutonomyOutcome = "done" | "no-update" | "blocked" | "error";

export interface AutonomyRun {
  kind: AutonomyKind;
  /** Task name for heartbeat/desire/examen runs (e.g. "desire:learn-rust"). */
  task?: string;
  /** ISO 8601 start time. */
  startedAt: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  /** Tool calls observed during the run, when known. */
  toolCalls?: number;
  outcome: AutonomyOutcome;
  /** Short human note — failure reason, stop reason, etc. */
  note?: string;
}

/** Append one run record; trim the ledger opportunistically. Never throws. */
export async function recordAutonomyRun(run: AutonomyRun): Promise<void> {
  try {
    await appendLine(RUNS_FILE, JSON.stringify(run));
  } catch {
    return; // recording is best-effort; never break the autonomy run on it
  }
  try {
    const lineCount = (await readTextOrEmpty(RUNS_FILE)).split("\n").filter((l) => l.trim()).length;
    if (lineCount > MAX_RUNS) {
      await withFileLock(
        RUNS_LOCK,
        async () => {
          const lines = (await readTextOrEmpty(RUNS_FILE)).split("\n").filter((l) => l.trim());
          if (lines.length > MAX_RUNS) {
            await atomicWrite(RUNS_FILE, lines.slice(lines.length - MAX_RUNS).join("\n") + "\n");
          }
        },
        { timeoutMs: 2_000, staleMs: 60_000 },
      );
    }
  } catch {
    // trimming is best-effort
  }
}

/** Read run records, optionally only those within the last `sinceMs`. */
export async function readAutonomyRuns(sinceMs?: number): Promise<AutonomyRun[]> {
  const raw = await readTextOrEmpty(RUNS_FILE);
  const cutoff = sinceMs != null ? Date.now() - sinceMs : null;
  const out: AutonomyRun[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const run = JSON.parse(t) as AutonomyRun;
      if (cutoff != null && new Date(run.startedAt).getTime() < cutoff) continue;
      out.push(run);
    } catch {
      // skip a malformed line rather than failing the whole read
    }
  }
  return out;
}

/** Human-readable digest for `lisa autonomy`. */
export function summarizeAutonomyRuns(runs: AutonomyRun[]): string {
  if (runs.length === 0) return "No autonomy runs recorded yet.";
  const byKind = new Map<string, number>();
  const byOutcome = new Map<string, number>();
  let inTok = 0;
  let outTok = 0;
  for (const r of runs) {
    byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
    byOutcome.set(r.outcome, (byOutcome.get(r.outcome) ?? 0) + 1);
    inTok += r.inputTokens || 0;
    outTok += r.outputTokens || 0;
  }
  const fmtMap = (m: Map<string, number>) =>
    Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n}`)
      .join(" · ");
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const recent = runs
    .slice(-10)
    .reverse()
    .map((r) => {
      const when = r.startedAt.replace("T", " ").slice(0, 16);
      const label = (r.task ?? r.kind).padEnd(22).slice(0, 22);
      const tok = k((r.inputTokens || 0) + (r.outputTokens || 0));
      return `  ${when}  ${label} ${r.outcome.padEnd(10)} ${tok} tok`;
    })
    .join("\n");
  return [
    `Autonomy runs: ${runs.length} total`,
    `  by kind:    ${fmtMap(byKind)}`,
    `  by outcome: ${fmtMap(byOutcome)}`,
    `  tokens:     in ${k(inTok)} · out ${k(outTok)}`,
    `  recent:`,
    recent,
  ].join("\n");
}
