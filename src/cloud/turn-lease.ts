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
import { firestoreEnabled, acquireLease, releaseLease, type LeaseHandle } from "./firestore.js";

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

export async function releaseTurnLease(lease: TurnLease | null): Promise<void> {
  if (lease && lease !== "off") await releaseLease(lease);
}
