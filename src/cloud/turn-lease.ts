/**
 * Per-uid turn lease (B9) — cross-INSTANCE serialization of metered turns.
 *
 * The in-process ChatCtx chain already serializes one account's turns inside a
 * single instance; once max-instances > 1 two instances could still run the
 * same account concurrently (double free-window spend, racing soul writes).
 * With Firestore enabled, every metered turn (chat + gateway) first takes
 * `lisa-leases/turn-<uid>`: waiting briefly for a busy peer, then answering
 * 429 rather than double-running.
 *
 * TTL is the backstop for crashed holders: a turn that outlives it risks
 * overlap, so it's set well above the p99 turn. Firestore OFF ⇒ "off" (no-op),
 * preserving today's single-instance behavior byte for byte.
 */
import crypto from "node:crypto";
import { firestoreEnabled, acquireLease, releaseLease, renewLease, type LeaseHandle } from "./firestore.js";

const OWNER = `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
const TURN_TTL_MS = 180_000;

export type TurnLease = LeaseHandle | "off";

/**
 * Acquire the uid's turn lease, polling a busy one for up to `waitMs`.
 * "off" when Firestore is disabled; null when a live peer held it throughout.
 */
export async function acquireTurnLease(uid: string, waitMs = 15_000): Promise<TurnLease | null> {
  if (!firestoreEnabled()) return "off";
  const deadline = Date.now() + waitMs;
  for (;;) {
    const handle = await acquireLease(`turn-${uid}`, OWNER, TURN_TTL_MS);
    if (handle) return handle;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 750));
  }
}

/**
 * Heartbeat a held lease so a long turn keeps it (#272). Chat SSE runs under
 * `--timeout 3600` — 20× the TTL — so without this the lease expires mid-turn
 * and a peer instance happily starts a second run of the same account. Renews
 * at TTL/3 (two missed beats still leave a full renewal of slack), and stops
 * renewing if ownership is ever lost. Returns a stop fn for the `finally`.
 */
export function startLeaseRenewal(lease: TurnLease | null): () => void {
  if (!lease || lease === "off") return () => {};
  let stopped = false;
  const timer = setInterval(() => {
    void (async () => {
      if (stopped) return;
      const held = await renewLease(lease, TURN_TTL_MS);
      if (!held && !stopped) {
        // Someone else owns it now; keeping the beat going would steal it back.
        stopped = true;
        clearInterval(timer);
        console.error(`[lease] lost ${lease.path} mid-turn — renewal stopped`);
      }
    })();
  }, Math.floor(TURN_TTL_MS / 3));
  timer.unref?.(); // never hold the process open on a heartbeat
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export async function releaseTurnLease(lease: TurnLease | null): Promise<void> {
  if (lease && lease !== "off") await releaseLease(lease);
}
