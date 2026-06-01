/**
 * Scheduled dispatches — a small persisted store of "launch agent X in repo Y
 * with task Z on schedule S". The heartbeat runner checks it each tick and
 * fires the due ones (see fireDueScheduledDispatches, called from the runner).
 *
 * Safety: this auto-launches autonomous agents unattended at heartbeat cadence,
 * so each entry carries a maxRuns cap (default 30) and records its run count;
 * once spent it's inert until the user removes/re-adds it.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { atomicWrite } from "../fs-utils.js";
import { LISA_HOME } from "../paths.js";

export type ScheduledAgent = "claude" | "codex" | "opencode" | "aider";

export interface ScheduledDispatch {
  id: string;
  agent: ScheduledAgent;
  task: string;
  cwd: string;
  /** "every:30m" | "every:2h" | "every:1d" | "daily:09:00" */
  schedule: string;
  maxRuns: number;
  runs: number;
  lastRunAt?: number;
  createdAt: number;
}

const FILE = path.join(LISA_HOME, "scheduled-dispatches.json");
export const DEFAULT_MAX_RUNS = 30;

interface Store {
  entries: ScheduledDispatch[];
}

export async function loadScheduled(): Promise<ScheduledDispatch[]> {
  try {
    const raw = await readFile(FILE, "utf8");
    const store = JSON.parse(raw) as Store;
    return Array.isArray(store.entries) ? store.entries : [];
  } catch {
    return [];
  }
}

async function saveScheduled(entries: ScheduledDispatch[]): Promise<void> {
  await atomicWrite(FILE, JSON.stringify({ entries }, null, 2));
}

export async function addScheduled(
  e: Omit<ScheduledDispatch, "id" | "runs" | "createdAt"> & { createdAt?: number },
): Promise<ScheduledDispatch> {
  const entries = await loadScheduled();
  const entry: ScheduledDispatch = {
    ...e,
    id: randomUUID().slice(0, 8),
    runs: 0,
    createdAt: e.createdAt ?? Date.now(),
  };
  entries.push(entry);
  await saveScheduled(entries);
  return entry;
}

export async function removeScheduled(id: string): Promise<boolean> {
  const entries = await loadScheduled();
  const next = entries.filter((e) => e.id !== id && !e.id.startsWith(id));
  if (next.length === entries.length) return false;
  await saveScheduled(next);
  return true;
}

/** Persist run bookkeeping after a fire. */
export async function markRan(id: string, when: number): Promise<void> {
  const entries = await loadScheduled();
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  e.runs += 1;
  e.lastRunAt = when;
  await saveScheduled(entries);
}

/** Parse "every:<N><m|h|d>" → interval ms, or null if not that form. */
function parseEvery(schedule: string): number | null {
  const m = schedule.match(/^every:(\d+)([mhd])$/i);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  const unit = m[2]!.toLowerCase();
  return n * (unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
}

/** Parse "daily:HH:MM" → {h, m}, or null. */
function parseDaily(schedule: string): { h: number; m: number } | null {
  const m = schedule.match(/^daily:(\d{1,2}):(\d{2})$/i);
  if (!m) return null;
  const h = parseInt(m[1]!, 10);
  const min = parseInt(m[2]!, 10);
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

export function isValidSchedule(schedule: string): boolean {
  return parseEvery(schedule) !== null || parseDaily(schedule) !== null;
}

/**
 * Is this entry due to fire at `now`? Pure + testable.
 * - capped: false once runs >= maxRuns
 * - every:N — due when now - lastRunAt >= interval (or never run)
 * - daily:HH:MM — due when now is past today's HH:MM and it hasn't run since
 */
export function isDue(e: ScheduledDispatch, now: number): boolean {
  if (e.runs >= e.maxRuns) return false;

  const everyMs = parseEvery(e.schedule);
  if (everyMs !== null) {
    if (e.lastRunAt == null) return true;
    return now - e.lastRunAt >= everyMs;
  }

  const daily = parseDaily(e.schedule);
  if (daily) {
    const target = new Date(now);
    target.setHours(daily.h, daily.m, 0, 0);
    const targetMs = target.getTime();
    if (now < targetMs) return false; // today's time hasn't arrived
    // Past today's target: due unless we already ran at/after it.
    return e.lastRunAt == null || e.lastRunAt < targetMs;
  }

  return false; // unparseable schedule never fires
}

/**
 * Fire every due entry via the injected `launch` (dependency-injected so this
 * module stays free of the tools layer and is testable). Marks each fired entry
 * regardless of launch success, so a broken entry burns its run budget rather
 * than retrying every tick. Returns one summary line per fire.
 */
export async function fireDue(
  now: number,
  launch: (e: ScheduledDispatch) => Promise<{ pid?: number; error?: string }>,
): Promise<string[]> {
  const entries = await loadScheduled();
  const fired: string[] = [];
  for (const e of entries) {
    if (!isDue(e, now)) continue;
    let result: { pid?: number; error?: string };
    try {
      result = await launch(e);
    } catch (err) {
      result = { error: (err as Error).message };
    }
    await markRan(e.id, now);
    fired.push(`${e.agent} in ${e.cwd} — ${result.error ? "FAILED: " + result.error : "pid " + result.pid}`);
  }
  return fired;
}

/** Human description of an entry for listing. */
export function describeScheduled(e: ScheduledDispatch): string {
  const last = e.lastRunAt ? new Date(e.lastRunAt).toISOString().slice(0, 16).replace("T", " ") : "never";
  const task = e.task.length > 60 ? e.task.slice(0, 57) + "…" : e.task;
  return `• ${e.id}  ${e.agent} @ ${e.schedule}  (${e.runs}/${e.maxRuns} runs, last ${last})\n    ${e.cwd}\n    "${task}"`;
}
