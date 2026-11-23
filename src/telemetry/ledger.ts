/**
 * Local-only zero-egress telemetry ledger (docs/analytics-plan-2026-08-21.md §2, §6.1).
 *
 * Writes bounded, 30-day-retained JSONL records to `<lisaHome>/telemetry/events.jsonl`
 * (mode 0600) under a cross-process advisory file lock (`events.lock`) using atomic
 * temp-file renames.
 *
 * Guarantees:
 *  - Zero network egress (no HTTP/net/fetch imports or calls).
 *  - Never writes prompts, replies, file paths, repo names, URLs, or secrets:
 *    every record passes through `sanitizeTelemetryEvent` before serialization.
 *  - Honors `LISA_TELEMETRY=off` (and `LISA_TELEMETRY_LOCAL=0`).
 *  - Never throws into callers; write failures are logged best-effort.
 *  - Respects multi-tenant `homeScope` via `lisaHome()` from `../paths.js`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { edition, type Edition } from "../edition.js";
import { atomicWrite } from "../fs-utils.js";
import { logError } from "../log.js";
import { lisaHome } from "../paths.js";
import { withFileLock } from "../soul/lock.js";
import { sanitizeTelemetryEvent, type TelemetryEvent, type TelemetryEventName } from "./schema.js";

export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_MAX_LINES = 3000;
const DAY_MS = 24 * 60 * 60_000;
const DISABLED_VALUES = new Set(["off", "0", "false", "no", "disabled"]);

export interface TelemetryLedgerRecord<T extends TelemetryEvent = TelemetryEvent> {
  v: 1;
  name: T["name"];
  occurredAt: string;
  properties: T["properties"];
}

export interface TelemetryLedgerOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: number | Date;
  retentionDays?: number;
  maxLines?: number;
}

export interface TrackTelemetryOptions extends TelemetryLedgerOptions {
  edition?: Edition;
}

export interface ReadTelemetryOptions extends TelemetryLedgerOptions {
  days?: number;
  sinceMs?: number;
  limit?: number;
}

export interface TelemetrySummary {
  totalEvents: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
  byEvent: Partial<Record<TelemetryEventName, number>>;
  byDay: Record<string, number>;
  sessions: {
    started: number;
    ended: number;
    bySurface: Record<string, number>;
  };
  turns: {
    completed: number;
    byProvider: Record<string, number>;
    byTokensBucket: Record<string, number>;
    byStopReason: Record<string, number>;
  };
  tasks: {
    created: number;
    finished: number;
    byOutcome: Record<string, number>;
  };
  approvals: {
    decided: number;
    byVerdict: Record<string, number>;
    byCategory: Record<string, number>;
  };
  connectors: {
    authorized: number;
    succeeded: number;
    failed: number;
    byProvider: Record<string, number>;
  };
  cli: {
    commandsRun: number;
    succeeded: number;
    failed: number;
    byCommand: Record<string, number>;
  };
  births: {
    started: number;
    completed: number;
  };
  autonomy: {
    runs: number;
    byOutcome: Record<string, number>;
  };
}

/** Directory for the active home's local telemetry ledger. */
export function telemetryDir(home?: string): string {
  return home ? path.join(home, "telemetry") : path.join(lisaHome(), "telemetry");
}

/** Full path to the active home's `events.jsonl` ledger. */
export function telemetryFile(home?: string): string {
  return path.join(telemetryDir(home), "events.jsonl");
}

function telemetryLock(home?: string): string {
  return path.join(telemetryDir(home), "events.lock");
}

/** True unless `LISA_TELEMETRY=off` (or `LISA_TELEMETRY_LOCAL=0` / false / disabled). */
export function isTelemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const main = env.LISA_TELEMETRY?.trim().toLowerCase();
  if (main && DISABLED_VALUES.has(main)) return false;
  const local = env.LISA_TELEMETRY_LOCAL?.trim().toLowerCase();
  if (local && DISABLED_VALUES.has(local)) return false;
  return true;
}

function toEpochMs(now?: number | Date): number {
  if (now instanceof Date) {
    const t = now.getTime();
    return Number.isFinite(t) ? t : Date.now();
  }
  if (typeof now === "number" && Number.isFinite(now)) return now;
  return Date.now();
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function resolveRetentionDays(explicit: number | undefined, env?: NodeJS.ProcessEnv): number {
  if (explicit === Infinity) return Infinity;
  if (typeof explicit === "number") {
    return Number.isFinite(explicit) ? explicit : DEFAULT_RETENTION_DAYS;
  }
  return parsePositiveInt(env?.LISA_TELEMETRY_RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
}

function resolveMaxLines(explicit: number | undefined, env?: NodeJS.ProcessEnv): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }
  return parsePositiveInt(env?.LISA_TELEMETRY_MAX_LINES, DEFAULT_MAX_LINES);
}

// Per-file in-process serialization so concurrent calls don't spin-poll the lockfile.
const fileChains = new Map<string, Promise<unknown>>();

async function withLockedLedger<T>(
  file: string,
  lockFile: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(file);
  const previous = fileChains.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      return withFileLock(lockFile, fn, { createDir: true, timeoutMs: 3_000 });
    });
  fileChains.set(key, next);
  try {
    return await next;
  } finally {
    if (fileChains.get(key) === next) fileChains.delete(key);
  }
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLedgerContent(
  raw: string,
  cutoffMs: number | null,
): { records: TelemetryLedgerRecord[]; dropped: number } {
  const records: TelemetryLedgerRecord[] = [];
  let dropped = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      dropped++;
      continue;
    }
    if (!isRecordObject(parsed) || parsed.v !== 1 || typeof parsed.occurredAt !== "string") {
      dropped++;
      continue;
    }
    const ts = Date.parse(parsed.occurredAt);
    if (!Number.isFinite(ts)) {
      dropped++;
      continue;
    }
    if (cutoffMs !== null && ts < cutoffMs) {
      dropped++;
      continue;
    }
    const sanitized = sanitizeTelemetryEvent({
      name: parsed.name,
      properties: parsed.properties,
    });
    if (!sanitized) {
      dropped++;
      continue;
    }
    records.push({
      v: 1,
      name: sanitized.name,
      occurredAt: new Date(ts).toISOString(),
      properties: sanitized.properties,
    });
  }
  records.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  return { records, dropped };
}

function serializeRecords(records: readonly TelemetryLedgerRecord[]): string {
  return records.length === 0 ? "" : records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

function cutoffForDays(days: number, nowMs: number): number | null {
  if (days === Infinity) return null;
  if (!Number.isFinite(days) || days <= 0) return Infinity;
  return nowMs - days * DAY_MS;
}

async function readFileOrNull(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Prune records older than `days` (and drop corrupted lines / enforce `maxLines`).
 * Rewrites `events.jsonl` atomically at mode `0600` under the ledger lock.
 */
export async function pruneOlderThanDays(
  days: number = DEFAULT_RETENTION_DAYS,
  opts: TelemetryLedgerOptions = {},
): Promise<{ removed: number; kept: number }> {
  const targetHome = opts.home ?? lisaHome();
  const file = telemetryFile(targetHome);
  const lockFile = telemetryLock(targetHome);
  const nowMs = toEpochMs(opts.now);
  const maxLines = resolveMaxLines(opts.maxLines, opts.env);

  try {
    await fs.access(file);
  } catch {
    return { removed: 0, kept: 0 };
  }

  return withLockedLedger(file, lockFile, async () => {
    const raw = await readFileOrNull(file);
    if (raw === null) return { removed: 0, kept: 0 };
    const { records, dropped } = parseLedgerContent(raw, cutoffForDays(days, nowMs));
    const capped = records.length > maxLines ? records.slice(-maxLines) : records;
    const totalRemoved = dropped + (records.length - capped.length);
    if (totalRemoved > 0) {
      await atomicWrite(file, serializeRecords(capped), 0o600);
      await fs.chmod(file, 0o600).catch(() => undefined);
    }
    return { removed: totalRemoved, kept: capped.length };
  });
}

/**
 * Validate, sanitize, prune (30-day retention + maxLines), and append one
 * telemetry event to `<lisaHome>/telemetry/events.jsonl` (0600).
 *
 * Returns `true` if persisted, `false` if opted out, rejected fail-closed, or
 * failed on disk. Never throws.
 */
export async function trackTelemetry(
  event: TelemetryEvent,
  opts: TrackTelemetryOptions = {},
): Promise<boolean> {
  const env = opts.env ?? process.env;
  if (!isTelemetryEnabled(env)) return false;

  const activeEdition = opts.edition ?? edition(env);
  const sanitized = sanitizeTelemetryEvent(event, { edition: activeEdition });
  if (!sanitized) return false;

  // Resolve active home synchronously before any await so homeScope ALS stays pinned.
  const targetHome = opts.home ?? lisaHome();
  const file = telemetryFile(targetHome);
  const lockFile = telemetryLock(targetHome);
  const nowMs = toEpochMs(opts.now);
  const retentionDays = resolveRetentionDays(opts.retentionDays, env);
  const maxLines = resolveMaxLines(opts.maxLines, env);

  const record: TelemetryLedgerRecord = {
    v: 1,
    name: sanitized.name,
    occurredAt: new Date(nowMs).toISOString(),
    properties: sanitized.properties,
  };

  if (env.LISA_TELEMETRY_DEBUG === "1") {
    process.stderr.write(`[telemetry] ${JSON.stringify(record)}\n`);
  }

  try {
    await withLockedLedger(file, lockFile, async () => {
      const existingRaw = (await readFileOrNull(file)) ?? "";
      const { records } = parseLedgerContent(existingRaw, cutoffForDays(retentionDays, nowMs));
      records.push(record);
      records.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
      const bounded = records.length > maxLines ? records.slice(-maxLines) : records;
      await atomicWrite(file, serializeRecords(bounded), 0o600);
      await fs.chmod(file, 0o600).catch(() => undefined);
    });
    return true;
  } catch (err) {
    logError(`[telemetry] ledger write failed: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Read valid, non-expired events from `<lisaHome>/telemetry/events.jsonl`
 * sorted oldest -> newest. Corrupted lines are skipped without throwing.
 */
export async function readTelemetryEvents(
  opts: ReadTelemetryOptions = {},
): Promise<TelemetryLedgerRecord[]> {
  const targetHome = opts.home ?? lisaHome();
  const file = telemetryFile(targetHome);
  const nowMs = toEpochMs(opts.now);
  const retentionDays = resolveRetentionDays(opts.retentionDays, opts.env);

  let raw: string | null;
  try {
    raw = await readFileOrNull(file);
  } catch {
    return [];
  }
  if (raw === null) return [];

  let cutoffMs = cutoffForDays(retentionDays, nowMs);
  if (opts.days !== undefined && Number.isFinite(opts.days)) {
    const daysCutoff = cutoffForDays(opts.days, nowMs);
    if (daysCutoff !== null) {
      cutoffMs = cutoffMs === null ? daysCutoff : Math.max(cutoffMs, daysCutoff);
    }
  }
  if (opts.sinceMs !== undefined && Number.isFinite(opts.sinceMs)) {
    cutoffMs = cutoffMs === null ? opts.sinceMs : Math.max(cutoffMs, opts.sinceMs);
  }

  const { records } = parseLedgerContent(raw, cutoffMs);
  if (opts.limit !== undefined && Number.isFinite(opts.limit) && opts.limit >= 0) {
    const limit = Math.floor(opts.limit);
    return limit === 0 ? [] : records.slice(-limit);
  }
  return records;
}

/** Delete `<lisaHome>/telemetry/events.jsonl` under lock. Returns true if a file was removed. */
export async function clearTelemetryLedger(opts: { home?: string } = {}): Promise<boolean> {
  const targetHome = opts.home ?? lisaHome();
  const file = telemetryFile(targetHome);
  const lockFile = telemetryLock(targetHome);

  try {
    await fs.access(file);
  } catch {
    return false;
  }

  return withLockedLedger(file, lockFile, async () => {
    try {
      await fs.access(file);
    } catch {
      return false;
    }
    await fs.rm(file, { force: true });
    return true;
  });
}

function inc(map: Record<string, number>, key: string): void {
  const prev = Object.hasOwn(map, key) ? (map[key] ?? 0) : 0;
  map[key] = prev + 1;
}

/** Aggregate local ledger records into counts and domain breakdowns. */
export function summarizeTelemetry(events: readonly TelemetryLedgerRecord[]): TelemetrySummary {
  const summary: TelemetrySummary = {
    totalEvents: 0,
    firstEventAt: null,
    lastEventAt: null,
    byEvent: {},
    byDay: {},
    sessions: { started: 0, ended: 0, bySurface: {} },
    turns: { completed: 0, byProvider: {}, byTokensBucket: {}, byStopReason: {} },
    tasks: { created: 0, finished: 0, byOutcome: {} },
    approvals: { decided: 0, byVerdict: {}, byCategory: {} },
    connectors: { authorized: 0, succeeded: 0, failed: 0, byProvider: {} },
    cli: { commandsRun: 0, succeeded: 0, failed: 0, byCommand: {} },
    births: { started: 0, completed: 0 },
    autonomy: { runs: 0, byOutcome: {} },
  };

  for (const ev of events) {
    if (!ev || typeof ev.name !== "string" || typeof ev.occurredAt !== "string") continue;
    summary.totalEvents++;
    if (summary.firstEventAt === null || ev.occurredAt < summary.firstEventAt) {
      summary.firstEventAt = ev.occurredAt;
    }
    if (summary.lastEventAt === null || ev.occurredAt > summary.lastEventAt) {
      summary.lastEventAt = ev.occurredAt;
    }
    const prevEventCount = Object.hasOwn(summary.byEvent, ev.name)
      ? (summary.byEvent[ev.name] ?? 0)
      : 0;
    summary.byEvent[ev.name] = prevEventCount + 1;
    inc(summary.byDay, ev.occurredAt.slice(0, 10));

    const props = ev.properties as Record<string, unknown>;
    switch (ev.name) {
      case "birth_started":
        summary.births.started++;
        break;
      case "birth_completed":
        summary.births.completed++;
        break;
      case "session_started":
        summary.sessions.started++;
        if (typeof props.surface === "string") inc(summary.sessions.bySurface, props.surface);
        break;
      case "session_ended":
        summary.sessions.ended++;
        break;
      case "turn_completed":
        summary.turns.completed++;
        if (typeof props.provider === "string") inc(summary.turns.byProvider, props.provider);
        if (typeof props.tokens === "string") inc(summary.turns.byTokensBucket, props.tokens);
        if (typeof props.stopReason === "string") inc(summary.turns.byStopReason, props.stopReason);
        break;
      case "task_created":
        summary.tasks.created++;
        break;
      case "task_run_finished":
        summary.tasks.finished++;
        if (typeof props.outcome === "string") inc(summary.tasks.byOutcome, props.outcome);
        break;
      case "approval_decided":
        summary.approvals.decided++;
        if (typeof props.verdict === "string") inc(summary.approvals.byVerdict, props.verdict);
        if (typeof props.category === "string") inc(summary.approvals.byCategory, props.category);
        break;
      case "connector_authorized":
        summary.connectors.authorized++;
        if (props.ok === true) summary.connectors.succeeded++;
        else summary.connectors.failed++;
        if (typeof props.provider === "string") inc(summary.connectors.byProvider, props.provider);
        break;
      case "cli_command_run":
        summary.cli.commandsRun++;
        if (props.ok === true) summary.cli.succeeded++;
        else summary.cli.failed++;
        if (typeof props.command === "string") inc(summary.cli.byCommand, props.command);
        break;
      case "autonomy_run_recorded":
        summary.autonomy.runs++;
        if (typeof props.outcome === "string") inc(summary.autonomy.byOutcome, props.outcome);
        break;
      default:
        break;
    }
  }

  return summary;
}
