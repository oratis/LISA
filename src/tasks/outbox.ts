/**
 * Delivery outbox — task results reach the user exactly once, across restarts.
 *
 * The pattern is the one billing/outbox.ts uses for money: make the intent
 * durable FIRST, deliver afterwards, and give every notice a stable id so a
 * redelivery after a crash is recognisable.
 *
 *   <lisaHome>/tasks/outbox/<noticeId>.json
 *
 *   enqueue  — exclusive create keyed by `<runId>-<kind>`: enqueueing the same
 *              run's result twice (a resumed run re-finishing) is a no-op.
 *   drain    — for each pending entry: claim it under a lock, mark it
 *              `delivering`, call deliver(), mark it `delivered`.
 *
 * A crash between deliver() returning and the `delivered` write leaves the
 * entry in `delivering`; the next drain delivers it again WITH THE SAME
 * `notice.id`. deliver() implementations must therefore treat `notice.id` as an
 * idempotency key (the default one in web/tasks-delivery.ts does — it will not
 * persist a second card with the same id). At-least-once here + idempotent
 * consumer = exactly-once as the user sees it.
 *
 * deliver() outcomes:
 *   { delivered: true }                     → done.
 *   { delivered: false, reason }            → final: the gate decided this is
 *                                             not to be sent ("suppressed").
 *   { delivered: false, reason: "defer…" }  → not now; stays pending, retried
 *                                             on a later drain without counting
 *                                             as a failed attempt.
 *   throws                                  → transient; retried with backoff,
 *                                             given up after MAX_ATTEMPTS.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../fs-utils.js";
import { withFileLock } from "../soul/lock.js";
import { TaskGoneError, tasksDir, writeInPlace } from "./store.js";
import type { TaskDeliver, TaskNotice } from "./types.js";

export type OutboxState = "pending" | "delivering" | "delivered" | "suppressed" | "failed";

export interface OutboxEntry {
  id: string;
  notice: TaskNotice;
  state: OutboxState;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  /** Earliest time the next attempt may run (backoff). */
  notBefore?: number;
  reason?: string;
}

export const OUTBOX_MAX_ATTEMPTS = 6;
/** Delivered / suppressed / failed entries are kept this long for dedupe, then pruned. */
const RETAIN_MS = 14 * 86_400_000;

function outboxDir(): string {
  return path.join(tasksDir(), "outbox");
}

function entryFile(id: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{5,120}$/.test(id)) throw new Error(`invalid notice id: ${id}`);
  return path.join(outboxDir(), `${id}.json`);
}

/** The stable id of a run's notice of a given kind. */
export function noticeId(runId: string, kind: TaskNotice["kind"]): string {
  return `${runId}-${kind.replace(/_/g, "-")}`;
}

async function readEntry(id: string): Promise<OutboxEntry | null> {
  try {
    const entry = JSON.parse(await fsp.readFile(entryFile(id), "utf8")) as OutboxEntry;
    return entry && typeof entry === "object" && entry.notice ? entry : null;
  } catch {
    return null; // missing or unreadable — nothing we can deliver from it
  }
}

async function writeEntry(entry: OutboxEntry): Promise<void> {
  await writeInPlace(entryFile(entry.id), JSON.stringify(entry, null, 2), "the outbox");
}

function lockFor(id: string): string {
  return path.join(outboxDir(), ".locks", `${id}.lock`);
}

/**
 * Make `tasks/outbox/.locks`, one level at a time and only under an existing
 * tasks directory: the outbox never brings a deleted home back.
 */
async function ensureOutbox(): Promise<void> {
  if (!(await pathExists(tasksDir()))) throw new TaskGoneError("the tasks directory");
  for (const dir of [outboxDir(), path.join(outboxDir(), ".locks")]) {
    await fsp.mkdir(dir).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "EEXIST") return;
      if (e.code === "ENOENT") throw new TaskGoneError("the tasks directory");
      throw e;
    });
  }
}

/**
 * Record a notice for delivery. Idempotent on `notice.id`: returns the existing
 * entry (in whatever state it reached) when one is already there.
 */
export async function enqueueNotice(notice: TaskNotice, now = Date.now()): Promise<OutboxEntry> {
  const id = notice.id;
  await ensureOutbox();
  return await withFileLock(
    lockFor(id),
    async () => {
      if (await pathExists(entryFile(id))) {
        const existing = await readEntry(id);
        if (existing) return existing;
      }
      const entry: OutboxEntry = {
        id,
        notice,
        state: "pending",
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      };
      await writeEntry(entry);
      return entry;
    },
    { createDir: false },
  );
}

/**
 * Rewrite one entry under its lock (the user-initiated forget, which edits
 * the notice's text only). `fn` returns the new entry, or null to leave it.
 * True when the entry was rewritten.
 */
export async function rewriteOutboxEntry(
  id: string,
  fn: (entry: OutboxEntry) => OutboxEntry | null,
): Promise<boolean> {
  let file: string;
  try {
    file = entryFile(id);
  } catch {
    return false;
  }
  if (!(await pathExists(file))) return false;
  return await withFileLock(
    lockFor(id),
    async () => {
      const entry = await readEntry(id);
      if (!entry) return false;
      const next = fn(entry);
      if (!next) return false;
      await writeEntry(next);
      return true;
    },
    { createDir: false },
  );
}

export async function listOutbox(): Promise<OutboxEntry[]> {
  let names: string[];
  try {
    names = await fsp.readdir(outboxDir());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: OutboxEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const entry = await readEntry(name.slice(0, -".json".length)).catch(() => null);
    if (entry) out.push(entry);
  }
  out.sort((a, b) => a.createdAt - b.createdAt);
  return out;
}

function backoffMs(attempts: number): number {
  return Math.min(30 * 60_000, 15_000 * 2 ** Math.max(0, attempts - 1));
}

export interface DrainResult {
  delivered: number;
  suppressed: number;
  deferred: number;
  failed: number;
}

/**
 * Deliver every entry that is due. Safe to call concurrently from several
 * processes: each entry is claimed under its own lock, and a contender that
 * cannot take the lock skips the entry rather than waiting.
 */
export async function drainOutbox(
  deliver: TaskDeliver | undefined,
  now = Date.now(),
): Promise<DrainResult> {
  const result: DrainResult = { delivered: 0, suppressed: 0, deferred: 0, failed: 0 };
  for (const listed of await listOutbox()) {
    if (
      listed.state === "delivered" ||
      listed.state === "suppressed" ||
      listed.state === "failed"
    ) {
      if (now - listed.updatedAt > RETAIN_MS) {
        await fsp.rm(entryFile(listed.id), { force: true }).catch(() => {});
      }
      continue;
    }
    if (!deliver) {
      result.deferred++; // nothing wired yet — keep it for whoever wires one
      continue;
    }
    try {
      // The home may have been deleted since the listing: nothing is re-created.
      await ensureOutbox();
      await withFileLock(
        lockFor(listed.id),
        async () => {
          // Re-read under the lock: another process may have finished it.
          const entry = await readEntry(listed.id);
          if (!entry || (entry.state !== "pending" && entry.state !== "delivering")) return;
          if (entry.notBefore !== undefined && entry.notBefore > now) {
            result.deferred++;
            return;
          }
          entry.state = "delivering";
          entry.attempts += 1;
          entry.updatedAt = now;
          await writeEntry(entry);

          let outcome: { delivered: boolean; reason?: string };
          try {
            outcome = await deliver(entry.notice);
          } catch (err) {
            entry.reason = (err as Error).message?.slice(0, 300) ?? "deliver threw";
            if (entry.attempts >= OUTBOX_MAX_ATTEMPTS) {
              entry.state = "failed";
              result.failed++;
            } else {
              entry.state = "pending";
              entry.notBefore = now + backoffMs(entry.attempts);
              result.deferred++;
            }
            entry.updatedAt = now;
            await writeEntry(entry);
            return;
          }

          if (outcome.delivered) {
            entry.state = "delivered";
            delete entry.reason;
            result.delivered++;
          } else if (/^defer/i.test(outcome.reason ?? "")) {
            entry.state = "pending";
            entry.attempts -= 1; // a deferral is not a failed attempt
            entry.reason = outcome.reason;
            result.deferred++;
          } else {
            entry.state = "suppressed";
            entry.reason = outcome.reason ?? "not delivered";
            result.suppressed++;
          }
          delete entry.notBefore;
          entry.updatedAt = now;
          await writeEntry(entry);
        },
        // deliver() runs under the lock, so a holder may legitimately be slow;
        // contenders give up at once instead of queueing behind it.
        { timeoutMs: 0, staleMs: 5 * 60_000, createDir: false },
      );
    } catch (err) {
      if (!(err as Error).message?.includes("timed out acquiring lock")) throw err;
      result.deferred++;
    }
  }
  return result;
}
