/**
 * Real coding-plan usage (CODING_PLANS Phase 5a) — honest, local, no faked %.
 *
 * Subscription plans are rate-limited, not metered, and the per-window limit
 * isn't published in token terms — so we do NOT invent a "headroom %". What we
 * CAN show truthfully is *consumption*: Claude Code records per-turn token usage
 * in its local transcripts (`~/.claude/projects/**​/*.jsonl`), each line stamped
 * with a `timestamp` and a `message.usage` object. Summing those over Claude's
 * rolling ~5-hour limit window (and since local midnight) is real usage from
 * local data — the same `usage` field the claude-code observer already reads, so
 * the metadata-not-payload privacy posture holds (we read token COUNTS and
 * timestamps only, never message content).
 *
 * Codex / Copilot have no comparable standard local token log, so usage is null
 * for them rather than guessed.
 */
import { readdirSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PlanId } from "./plans.js";

/** Claude subscription limits reset on a rolling ~5h basis. */
export const WINDOW_HOURS = 5;
/** Safety cap on transcript files scanned per call (newest first). */
const MAX_FILES = 80;

export interface PlanUsage {
  /** Gross tokens (input + output + cache create + cache read) in the rolling window. */
  windowTokens: number;
  windowHours: number;
  /** Gross tokens since local midnight. */
  todayTokens: number;
  /** Transcript files that contributed to the window/today. */
  sessions: number;
}

interface UsageEntry {
  atMs: number;
  tokens: number;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Sum the billable token fields from a Claude `usage` object. Pure. */
export function usageTokens(u: Record<string, unknown>): number {
  return (
    num(u.input_tokens) +
    num(u.output_tokens) +
    num(u.cache_creation_input_tokens) +
    num(u.cache_read_input_tokens)
  );
}

/** Local midnight (ms) for the day containing nowMs. Pure-ish (no Date.now). */
export function startOfLocalDay(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Bucket timestamped token entries into rolling-window + today sums. Pure. */
export function aggregateUsage(
  entries: UsageEntry[],
  nowMs: number,
  windowMs: number,
  dayStartMs: number,
): { windowTokens: number; todayTokens: number } {
  const windowStart = nowMs - windowMs;
  let windowTokens = 0;
  let todayTokens = 0;
  for (const e of entries) {
    if (e.atMs >= windowStart) windowTokens += e.tokens;
    if (e.atMs >= dayStartMs) todayTokens += e.tokens;
  }
  return { windowTokens, todayTokens };
}

/** Recursively collect `*.jsonl` paths under dir (Claude nests one level). */
function listTranscripts(dir: string): Array<{ path: string; mtimeMs: number }> {
  const out: Array<{ path: string; mtimeMs: number }> = [];
  const walk = (d: string, depth: number) => {
    let ents: import("node:fs").Dirent[];
    try {
      ents = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) {
        if (depth < 3) walk(p, depth + 1);
      } else if (ent.isFile() && ent.name.endsWith(".jsonl")) {
        try {
          out.push({ path: p, mtimeMs: statSync(p).mtimeMs });
        } catch {
          /* unreadable → skip */
        }
      }
    }
  };
  walk(dir, 0);
  return out;
}

/**
 * Read Claude Code's local transcripts and sum token usage over the rolling
 * window + today. Returns null if the projects dir is absent/unreadable.
 */
export function readClaudeUsage(opts: { home?: string; nowMs: number }): PlanUsage | null {
  const home = opts.home ?? process.env.CLAUDE_HOME ?? join(homedir(), ".claude");
  const projects = join(home, "projects");
  const nowMs = opts.nowMs;
  const windowMs = WINDOW_HOURS * 3_600_000;
  const dayStart = startOfLocalDay(nowMs);
  const scanFrom = Math.min(nowMs - windowMs, dayStart);

  let files: Array<{ path: string; mtimeMs: number }>;
  try {
    files = listTranscripts(projects);
  } catch {
    return null;
  }
  if (files.length === 0) return null;

  // Only files touched within the scan window can hold in-window entries.
  // Newest first, capped, so a heavy history can't make this unbounded.
  const recent = files
    .filter((f) => f.mtimeMs >= scanFrom)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_FILES);

  const entries: UsageEntry[] = [];
  let sessions = 0;
  for (const f of recent) {
    let raw: string;
    try {
      raw = readFileSync(f.path, "utf8");
    } catch {
      continue;
    }
    let contributed = false;
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let e: { timestamp?: unknown; message?: { usage?: unknown } };
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const atMs = Date.parse(typeof e.timestamp === "string" ? e.timestamp : "");
      if (!Number.isFinite(atMs) || atMs < scanFrom) continue;
      const u = e.message?.usage;
      if (!u || typeof u !== "object") continue;
      const tokens = usageTokens(u as Record<string, unknown>);
      if (tokens > 0) {
        entries.push({ atMs, tokens });
        contributed = true;
      }
    }
    if (contributed) sessions++;
  }

  const { windowTokens, todayTokens } = aggregateUsage(entries, nowMs, windowMs, dayStart);
  return { windowTokens, windowHours: WINDOW_HOURS, todayTokens, sessions };
}

/** Usage for a plan, or null if it has no readable local token log. */
export function planUsage(id: PlanId, nowMs: number): PlanUsage | null {
  if (id === "claude") return readClaudeUsage({ nowMs });
  return null; // codex / copilot: no standard local token log
}

/** Compact token count, e.g. 1234567 → "1.2M". Pure. */
export function formatTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "K";
  return String(n);
}

/** One-line usage summary, e.g. "1.2M tok in 5h · 4.8M today". Pure. */
export function formatUsage(u: PlanUsage): string {
  return `${formatTokens(u.windowTokens)} tok in ${u.windowHours}h · ${formatTokens(u.todayTokens)} today`;
}
