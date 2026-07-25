/**
 * Single-flight birth hub (S3) — one soul, one dream, any number of watchers.
 *
 * Two paths can start a per-uid birth: the background lazy path (a signed-in
 * user's first request, ensureUserBirth) and the visible ceremony
 * (POST /api/birth SSE from the web UI). Un-deduplicated they each ran their
 * own LLM call and raced on writeSeed. The hub keys one run per scope (uid on
 * cloud, "local" otherwise), records every step so a watcher that attaches
 * late replays the transcript before streaming live — the ceremony stays
 * visible even when the background path started the dream first.
 *
 * Cross-instance (B9/Firestore on): the run first takes `lisa-leases/birth-
 * <key>`. Losing it means a peer instance is already birthing this soul, so
 * the run waits the peer out instead of double-dreaming, then resolves; the
 * caller re-checks isBorn(). Firestore off ⇒ in-process dedup only (correct
 * for the single-instance default).
 *
 * The exec closure runs inside the STARTING caller's AsyncLocalStorage home
 * scope — key and scope must name the same tenant.
 */
import crypto from "node:crypto";
import type { BirthLog } from "../soul/birth.js";
import { firestoreEnabled, acquireLease, releaseLease } from "../cloud/firestore.js";

export interface BirthRun {
  promise: Promise<void>;
  /** Transcript so far — late watchers replay it before going live. */
  steps: BirthLog[];
  listeners: Set<(log: BirthLog) => void>;
  done: boolean;
  error: string | null;
}

const OWNER = `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
const BIRTH_TTL_MS = 5 * 60 * 1000;
const PEER_POLL_MS = 3_000;

const runs = new Map<string, BirthRun>();

/** The in-flight run for a scope key, if any. */
export function birthRunFor(key: string): BirthRun | null {
  return runs.get(key) ?? null;
}

/** Test seam. */
export function resetBirthRuns(): void {
  runs.clear();
}

/**
 * Start (or join) the single birth run for `key`. `exec` is invoked at most
 * once per in-flight run and receives an emit fn to forward birth steps to
 * every watcher. The run removes itself when settled, so a FAILED birth can
 * be retried by the next call — while isBorn() keeps a succeeded one from
 * ever re-running.
 */
export function startBirthOnce(
  key: string,
  exec: (emit: (log: BirthLog) => void) => Promise<void>,
): BirthRun {
  const existing = runs.get(key);
  if (existing) return existing;

  const run: BirthRun = {
    steps: [],
    listeners: new Set(),
    done: false,
    error: null,
    promise: Promise.resolve(),
  };
  runs.set(key, run);

  const emit = (log: BirthLog): void => {
    run.steps.push(log);
    for (const l of run.listeners) {
      try {
        l(log);
      } catch {
        // a broken watcher never kills the birth
      }
    }
  };

  run.promise = (async () => {
    let lease: Awaited<ReturnType<typeof acquireLease>> = null;
    if (firestoreEnabled()) {
      lease = await acquireLease(`birth-${key}`, OWNER, BIRTH_TTL_MS);
      if (!lease) {
        // A peer instance holds the birth lease — wait it out, never double-dream.
        emit({ step: "soul", detail: "another instance is already dreaming this soul — waiting…" });
        const deadline = Date.now() + BIRTH_TTL_MS;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, PEER_POLL_MS));
          lease = await acquireLease(`birth-${key}`, OWNER, BIRTH_TTL_MS);
          if (lease) break;
        }
        if (lease) {
          // Peer finished (or died). Release and let the caller re-check isBorn.
          await releaseLease(lease);
          return;
        }
        throw new Error("timed out waiting for a peer instance's birth");
      }
    }
    try {
      await exec(emit);
    } finally {
      if (lease) await releaseLease(lease);
    }
  })();

  run.promise
    .catch((e) => {
      run.error = (e as Error).message;
    })
    .finally(() => {
      run.done = true;
      runs.delete(key);
    });
  // Fire-and-forget callers (lazy birth) never observe the rejection directly.
  run.promise.catch(() => {});
  return run;
}
