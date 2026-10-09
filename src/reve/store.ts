/**
 * Dream record storage: read / list / validate / retention.
 *
 * Layout under `<lisaHome>/reve/dreams/`:
 *   <id>.json         the full DreamRecord (diffs size-capped)
 *   <id>.md           a short human summary
 *   <id>.before.json  pre-pass content of the USER-owned files that changed
 *                     (memory / kb / skills) — the revert source. Never soul.
 *
 * Everything resolves through lisaHome(), so on the cloud edition a request
 * scoped to uid A can only ever see `users/A/reve/…` (tenant isolation by
 * construction; ids are validated so a crafted id cannot escape the dir).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "../fs-utils.js";
import { withFileLock } from "../soul/lock.js";
import {
  dreamFile,
  dreamSnapshotFile,
  dreamsDir,
  isValidDreamId,
  reveAuditFile,
  reveLockPath,
} from "./paths.js";
import {
  DREAM_RECORD_VERSION,
  DREAM_TRIGGERS,
  USER_PARTS,
  type DreamPart,
  type DreamRecord,
  type DreamSummary,
  type UserPart,
} from "./types.js";

/** Retention: keep the newest KEEP_COUNT dreams or the last KEEP_DAYS, whichever is larger… */
export const RETENTION_KEEP_COUNT = 60;
export const RETENTION_KEEP_DAYS = 90;
/** …never more than MAX_COUNT dreams in all (20-minute idle runs make ~6500 in 90 days)… */
export const RETENTION_MAX_COUNT = 500;
/** …bounded by total bytes on disk (never pruning below RETENTION_FLOOR). */
export const RETENTION_MAX_BYTES = 64 * 1024 * 1024;
export const RETENTION_FLOOR = 10;
/** Retention runs at most this often per home and process (and on the first chance after start). */
export const RETENTION_INTERVAL_MS = 60 * 60_000;

/** Whole-record cap, on write and on read (a bigger record is served trimmed). */
export const MAX_RECORD_BYTES = 512 * 1024;
/** A record file bigger than this is not even parsed. */
export const MAX_READ_BYTES = 16 * 1024 * 1024;
/** Audit log retention: lines older than the dream retention window go, and at most this many stay. */
export const AUDIT_MAX_LINES = 5000;

export class DreamNotFoundError extends Error {
  constructor(id: string) {
    super(`dream not found: ${id}`);
    this.name = "DreamNotFoundError";
  }
}

export class CorruptDreamError extends Error {
  constructor(id: string, why: string) {
    super(`dream ${id} is corrupt: ${why}`);
    this.name = "CorruptDreamError";
  }
}

/** The memory entry lines one dream added and removed in one file. */
export interface MemoryEntryDelta {
  added: string[];
  removed: string[];
}

/**
 * Revert sidecar.
 *  - `files`: KB / skills — pre-pass content per relPath; null = the file did
 *    not exist. Restored file by file, hash-checked.
 *  - `memory`: per memory file, only the entry lines the dream added and
 *    removed. A memory revert works entry by entry against the current file
 *    and never restores a whole pre-dream file, so it can never bring back an
 *    entry the dream did not remove.
 */
export interface DreamSnapshotSidecar {
  version: 1;
  id: string;
  files: Record<string, string | null>;
  memory?: Record<string, MemoryEntryDelta>;
}

export function lockReve<T>(fn: () => Promise<T>): Promise<T> {
  return withFileLock(reveLockPath(), fn, { timeoutMs: 10_000, staleMs: 60_000 });
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Minimal structural validation — enough that downstream code can trust the shape. */
export function validateDreamRecord(raw: unknown, id: string): DreamRecord {
  if (!isObj(raw)) throw new CorruptDreamError(id, "not an object");
  if (raw.version !== DREAM_RECORD_VERSION) throw new CorruptDreamError(id, "unknown version");
  if (raw.id !== id) throw new CorruptDreamError(id, "id mismatch");
  if (!DREAM_TRIGGERS.includes(raw.trigger as never))
    throw new CorruptDreamError(id, "bad trigger");
  for (const k of [
    "changes",
    "soulCommits",
    "autonomyRunIds",
    "reconsiderDelivered",
    "reverts",
    "skillsTouched",
  ]) {
    if (!Array.isArray(raw[k])) throw new CorruptDreamError(id, `${k} missing`);
  }
  if (!isObj(raw.metrics) || !isObj(raw.desires))
    throw new CorruptDreamError(id, "metrics/desires missing");
  for (const c of raw.changes as unknown[]) {
    if (!isObj(c) || typeof c.path !== "string" || typeof c.part !== "string") {
      throw new CorruptDreamError(id, "bad change entry");
    }
  }
  return raw as unknown as DreamRecord;
}

/** Trim diffs (largest first), then entry lists and changes, until the record fits `cap`. */
export function fitRecord(rec: DreamRecord, cap: number): DreamRecord {
  const size = () => Buffer.byteLength(JSON.stringify(rec), "utf8");
  if (size() <= cap) return rec;
  rec.truncated = true;
  const diffs: Array<{ get: () => string; set: (s: string) => void }> = [
    ...rec.changes.map((c) => ({
      get: () => (typeof c.diff === "string" ? c.diff : ""),
      set: (s: string) => {
        c.diff = s;
        c.diffTruncated = true;
      },
    })),
    ...rec.soulCommits.map((c) => ({
      get: () => (typeof c.diff === "string" ? c.diff : ""),
      set: (s: string) => {
        c.diff = s;
        c.diffTruncated = true;
      },
    })),
  ].sort((a, b) => b.get().length - a.get().length);
  for (const limit of [1024, 128, 0]) {
    for (const d of diffs) {
      const text = d.get();
      if (text.length > limit)
        d.set(limit ? text.slice(0, limit) + "\n… [trimmed to fit the record]" : "");
      if (size() <= cap) return rec;
    }
  }
  // Still too big: drop the listed entries, then keep only the first N changes / commits.
  for (const c of rec.changes) {
    if (c.entriesAdded) c.entriesAdded = c.entriesAdded.slice(0, 5);
    if (c.entriesRemoved) c.entriesRemoved = c.entriesRemoved.slice(0, 5);
  }
  while (size() > cap && rec.soulCommits.length > 1) rec.soulCommits.pop();
  while (size() > cap && rec.changes.length > 1) rec.changes.pop();
  if (size() > cap && typeof rec.summary === "string") rec.summary = rec.summary.slice(0, 2000);
  return rec;
}

/**
 * Read a record as stored. Internal callers (revert, forget) need it whole.
 * Throws DreamNotFoundError / CorruptDreamError (also for a file past
 * MAX_READ_BYTES, which is never parsed).
 */
export async function readDream(id: string): Promise<DreamRecord> {
  if (!isValidDreamId(id)) throw new DreamNotFoundError(String(id).slice(0, 40));
  let text: string;
  try {
    const st = await fs.stat(dreamFile(id));
    if (st.size > MAX_READ_BYTES) throw new CorruptDreamError(id, "record too large to read");
    text = await fs.readFile(dreamFile(id), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new DreamNotFoundError(id);
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CorruptDreamError(id, "invalid JSON");
  }
  return validateDreamRecord(parsed, id);
}

/**
 * A record as SHOWN (API / CLI): capped like a write is. A record bigger than
 * MAX_RECORD_BYTES (written by something else, or tampered) comes back
 * trimmed, with `readTruncated: true`.
 */
export async function readDreamView(id: string): Promise<DreamRecord> {
  const rec = await readDream(id);
  if (Buffer.byteLength(JSON.stringify(rec), "utf8") <= MAX_RECORD_BYTES) return rec;
  const view = fitRecord(rec, MAX_RECORD_BYTES);
  view.readTruncated = true;
  return view;
}

export async function readDreamSidecar(id: string): Promise<DreamSnapshotSidecar | null> {
  let text: string;
  try {
    text = await fs.readFile(dreamSnapshotFile(id), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as DreamSnapshotSidecar;
    if (!isObj(parsed) || parsed.id !== id || !isObj(parsed.files)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeDreamRecord(rec: DreamRecord): Promise<void> {
  await atomicWrite(dreamFile(rec.id), JSON.stringify(rec, null, 2) + "\n");
}

/** One readdir of the dreams dir: ids (newest first) and the file names present. */
async function listDreamsDir(): Promise<{ ids: string[]; names: Set<string> }> {
  let names: string[];
  try {
    names = await fs.readdir(dreamsDir());
  } catch {
    return { ids: [], names: new Set() };
  }
  const ids = new Set<string>();
  for (const n of names) {
    const id = n.replace(/\.(before\.json|json|md)$/, "");
    if (id !== n && isValidDreamId(id)) ids.add(id);
  }
  return { ids: [...ids].sort().reverse(), names: new Set(names) };
}

/** Dream ids present on disk (any of the three files), newest first. */
export async function idsOnDisk(): Promise<string[]> {
  return (await listDreamsDir()).ids;
}

export function summarizeDream(rec: DreamRecord): DreamSummary {
  const parts = [...new Set<DreamPart>(rec.changes.map((c) => c.part))];
  if (rec.soulCommits.length && !parts.includes("soul")) parts.push("soul");
  const revertibleParts: UserPart[] = USER_PARTS.filter((p) =>
    rec.changes.some((c) => c.part === p && c.revertible),
  );
  return {
    id: rec.id,
    trigger: rec.trigger,
    ...(rec.task ? { task: rec.task } : {}),
    windowStart: rec.windowStart,
    windowEnd: rec.windowEnd,
    outcome: rec.outcome,
    capture: rec.capture,
    summary: rec.summary,
    parts: parts.sort(),
    revertibleParts,
    soulCommitCount: rec.soulCommits.length,
    changeCount: rec.changes.length,
    metrics: rec.metrics,
    reverted: rec.reverts.length > 0,
  };
}

export interface DreamListing {
  dreams: DreamSummary[];
  /** Records that exist but could not be parsed (skipped, never fatal). */
  corrupt: string[];
}

/** Newest-first summaries. Corrupt records are skipped and reported. */
export async function listDreams(limit = 20): Promise<DreamListing> {
  const max = Math.max(1, Math.min(500, Math.floor(limit) || 20));
  const out: DreamSummary[] = [];
  const corrupt: string[] = [];
  for (const id of await idsOnDisk()) {
    if (out.length >= max) break;
    try {
      out.push(summarizeDream(await readDream(id)));
    } catch (err) {
      if (err instanceof DreamNotFoundError) continue; // orphan sidecar / md
      corrupt.push(id);
    }
  }
  return { dreams: out, corrupt };
}

/** Full records within the last `days` (oldest first), corrupt ones skipped. */
export async function readDreamsSince(sinceMs: number): Promise<DreamRecord[]> {
  const out: DreamRecord[] = [];
  for (const id of await idsOnDisk()) {
    try {
      const rec = await readDream(id);
      if (Date.parse(rec.windowStart) >= sinceMs) out.push(rec);
    } catch {
      // skip corrupt / orphan
    }
  }
  return out.reverse();
}

/** Time encoded in the id (UTC, second precision). */
export function dreamIdTime(id: string): number {
  const m = /^d-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})-/.exec(id);
  if (!m) return 0;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!, +m[7]!);
}

async function dreamBytes(id: string): Promise<number> {
  let total = 0;
  for (const ext of [".json", ".md", ".before.json"]) {
    try {
      total += (await fs.stat(path.join(dreamsDir(), id + ext))).size;
    } catch {
      // missing part
    }
  }
  return total;
}

async function deleteDreamFiles(id: string): Promise<void> {
  for (const ext of [".json", ".md", ".before.json"]) {
    await fs.rm(path.join(dreamsDir(), id + ext), { force: true });
  }
}

/**
 * Apply retention. Caller holds the reve lock. Keeps a dream when it is among
 * the newest RETENTION_KEEP_COUNT OR younger than RETENTION_KEEP_DAYS, but
 * never more than the newest RETENTION_MAX_COUNT; then, oldest first, prunes
 * kept dreams while total bytes exceed the cap (never below
 * RETENTION_FLOOR). Orphan files (no .json) are removed.
 */
export async function applyRetention(
  now: number = Date.now(),
  limits: {
    keepCount?: number;
    keepDays?: number;
    maxCount?: number;
    maxBytes?: number;
    floor?: number;
  } = {},
): Promise<string[]> {
  const keepCount = limits.keepCount ?? RETENTION_KEEP_COUNT;
  const keepDays = limits.keepDays ?? RETENTION_KEEP_DAYS;
  const maxCount = limits.maxCount ?? RETENTION_MAX_COUNT;
  const maxBytes = limits.maxBytes ?? RETENTION_MAX_BYTES;
  const floor = limits.floor ?? RETENTION_FLOOR;
  const { ids, names } = await listDreamsDir(); // newest first; one readdir, no per-id stat
  const removed: string[] = [];
  const kept: string[] = [];
  const cutoff = now - keepDays * 24 * 60 * 60_000;
  for (const id of ids) {
    const hasRecord = names.has(`${id}.json`);
    // An orphan sidecar / summary whose record never landed (crash mid-write)
    // is garbage — unless it is brand new and its record is being written now.
    if (!hasRecord && now - dreamIdTime(id) > 10 * 60_000) {
      await deleteDreamFiles(id);
      removed.push(id);
      continue;
    }
    if ((kept.length < keepCount || dreamIdTime(id) >= cutoff) && kept.length < maxCount) {
      kept.push(id);
    } else {
      await deleteDreamFiles(id);
      removed.push(id);
    }
  }
  const sizes = new Map<string, number>();
  let total = 0;
  for (const id of kept) {
    const b = await dreamBytes(id);
    sizes.set(id, b);
    total += b;
  }
  while (total > maxBytes && kept.length > floor) {
    const oldest = kept.pop()!;
    total -= sizes.get(oldest) ?? 0;
    await deleteDreamFiles(oldest);
    removed.push(oldest);
  }
  // The rest of reve/ ages out with the dreams: delivered reconsider notes
  // (and any whose dream is gone), and the audit log.
  const maxAgeMs = keepDays * 24 * 60 * 60_000;
  const { pruneReconsider } = await import("./reconsider.js");
  await pruneReconsider(now, maxAgeMs, new Set(kept)).catch(() => 0);
  await pruneAudit(now, maxAgeMs, AUDIT_MAX_LINES).catch(() => 0);
  return removed;
}

/** Audit-log retention: drop lines older than `maxAgeMs`, keep at most the newest `maxLines`. */
export async function pruneAudit(now: number, maxAgeMs: number, maxLines: number): Promise<number> {
  let text: string;
  try {
    text = await fs.readFile(reveAuditFile(), "utf8");
  } catch {
    return 0;
  }
  const lines = text.split("\n").filter((l) => l.trim());
  const young = lines.filter((l) => {
    try {
      const at = Date.parse((JSON.parse(l) as { at?: string }).at ?? "");
      return !Number.isFinite(at) || now - at <= maxAgeMs;
    } catch {
      return true;
    }
  });
  const kept = young.slice(-maxLines);
  if (kept.length === lines.length) return 0;
  await atomicWrite(reveAuditFile(), kept.length ? kept.join("\n") + "\n" : "");
  return lines.length - kept.length;
}

/** Last retention run per reve dir, in this process. */
const lastRetention = new Map<string, number>();

/**
 * Run retention when it is due for the active home: at most once per
 * RETENTION_INTERVAL_MS per process, and on the first call after start.
 * Takes the reve lock itself (a short, separate critical section, not the
 * one a dream's record write holds). Never throws; returns what it removed,
 * or null when it was not due.
 */
export async function maybeApplyRetention(now: number = Date.now()): Promise<string[] | null> {
  const key = dreamsDir();
  const last = lastRetention.get(key);
  if (last !== undefined && now - last < RETENTION_INTERVAL_MS && now >= last) return null;
  lastRetention.set(key, now);
  try {
    return await lockReve(() => applyRetention(now));
  } catch {
    return null; // best-effort; the next due run tries again
  }
}
