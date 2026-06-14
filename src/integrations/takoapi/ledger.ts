/**
 * TakoAPI call ledger (Dispatch D2b) — a small persistent record of the REMOTE
 * agents LISA has called via the `takoapi` tool, so the orchestrator hub can
 * surface them as first-class sessions (with their last A2A TaskState) alongside
 * local agents. Mirrors dispatch-ledger.ts.
 *
 * DISCIPLINE: this records only agents LISA actually CALLED — never the
 * ~200-agent registry. Discovery stays in the `takoapi discover` tool; the hub
 * only ever shows agents you've interacted with (called) plus an explicit pin
 * list (config).
 *
 * PRIVACY: structural only — slug, A2A task id, TaskState, timestamps. Never the
 * prompt sent or the reply received (those flow through the tool, not here).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

export interface TakoCallEntry {
  /** Agent slug — the session identity (one entry per slug; latest call wins). */
  slug: string;
  /** A2A task id, if the response carried one. */
  taskId?: string;
  /** Epoch ms of the first recorded call to this slug. */
  startedAt: number;
  /** Epoch ms of the most recent update. */
  lastMtime: number;
  /** Last observed A2A TaskState string (e.g. "completed", "working"). */
  lastState: string;
}

/** How long a call is retained for readback after its last update. */
const RETAIN_MS = 24 * 60 * 60_000;

/**
 * Fires "change" after every successful write so the in-process observer can
 * push a live update. The `takoapi` tool and the hub share one process, so an
 * in-process event is enough (and simpler/safer than fs.watch).
 */
export const takoLedgerEvents = new EventEmitter();
takoLedgerEvents.setMaxListeners(64);

function lisaHome(): string {
  return process.env.LISA_HOME ?? path.join(os.homedir(), ".lisa");
}

/** Resolved lazily (reads env at call time) so tests can point LISA_HOME at a tmp dir. */
function ledgerPath(): string {
  return path.join(lisaHome(), "takoapi-calls.json");
}

/** Read the ledger; tolerant of a missing or corrupt file (returns []). */
export function loadTakoLedger(): TakoCallEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(ledgerPath(), "utf8");
  } catch {
    return []; // no file yet
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is TakoCallEntry =>
        !!e &&
        typeof (e as TakoCallEntry).slug === "string" &&
        typeof (e as TakoCallEntry).lastState === "string" &&
        typeof (e as TakoCallEntry).lastMtime === "number",
    );
  } catch {
    return []; // corrupt JSON — treat as empty rather than throwing
  }
}

function saveTakoLedger(entries: TakoCallEntry[]): void {
  const file = ledgerPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(entries, null, 2));
}

/** Record (upsert by slug) a call LISA made to a remote agent. Returns the entry. */
export function recordTakoCall(d: {
  slug: string;
  state: string;
  taskId?: string;
  /** Override the clock (tests). */
  now?: number;
}): TakoCallEntry {
  const now = d.now ?? Date.now();
  const existing = loadTakoLedger();
  const prior = existing.find((e) => e.slug === d.slug);
  const entry: TakoCallEntry = {
    slug: d.slug,
    lastState: d.state,
    lastMtime: now,
    startedAt: prior?.startedAt ?? now,
    // Keep the freshest task id; fall back to the prior one if this call had none.
    ...(d.taskId
      ? { taskId: d.taskId }
      : prior?.taskId
        ? { taskId: prior.taskId }
        : {}),
  };
  // Replace the same-slug entry and age out calls older than the retention window.
  const cutoff = now - RETAIN_MS;
  const next = existing.filter((e) => e.slug !== d.slug && e.lastMtime >= cutoff);
  next.push(entry);
  saveTakoLedger(next);
  takoLedgerEvents.emit("change");
  return entry;
}

/** All retained calls, newest first; prunes aged-out entries as a side effect. */
export function listTakoCalls(now = Date.now()): TakoCallEntry[] {
  const all = loadTakoLedger();
  const cutoff = now - RETAIN_MS;
  const keep = all.filter((e) => e.lastMtime >= cutoff);
  if (keep.length !== all.length) saveTakoLedger(keep);
  return keep.sort((a, b) => b.lastMtime - a.lastMtime);
}
