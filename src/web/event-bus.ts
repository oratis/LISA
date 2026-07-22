/**
 * Tenant-aware SSE fan-out for the web server's persistent `/events` stream.
 *
 * The problem this solves (PLAN_ACCOUNTS_BILLING B2): the `/events` stream is a
 * single process-wide broadcast. It carries `mood`, `chat_start`/`chat_end` and
 * `idle_message` events — the last of which contains message TEXT. Fanning every
 * event to every open connection is fine on the Mac edition (one implicit user)
 * but in the multi-tenant cloud edition it leaks one signed-in account's
 * activity — and idle-message content — to every other signed-in account.
 *
 * The fix is a uid match on both ends:
 *  - every subscriber is pinned to the uid it authenticated as, and
 *  - every event carries the uid of the home scope it originated in
 *    (`scopedUid()` at broadcast time; null for global/background work).
 * A subscriber receives an event only when the two uids are equal. The Mac
 * edition uses null for both, so the match is always true and delivery is
 * unchanged. The legacy shared-token cloud demo caller is also null-uid, so it
 * keeps seeing the global soul's background activity exactly as before.
 *
 * Kept as a standalone unit (not a closure inside `startWebServer`) so the
 * isolation rule is unit-testable without standing up an HTTP server — see
 * event-bus.test.ts.
 */

/** Anything we can push an SSE frame into. `http.ServerResponse` satisfies it. */
export interface EventSink {
  write(chunk: string): unknown;
}

/**
 * Deliver an event to a subscriber iff the two share a tenant.
 *
 * A plain uid equality, but named so both the persistent `/events` fan-out
 * (via {@link TenantEventBus}) and the `/chat` per-turn mood stream — which is
 * not a bus subscriber — enforce the *same* rule from one place. `null === null`
 * is intentional: it is how the single-tenant Mac edition and the shared-token
 * demo (one implicit, unscoped user) keep receiving everything.
 */
export function sameTenant(
  subscriberUid: string | null,
  originUid: string | null,
): boolean {
  return subscriberUid === originUid;
}

interface Subscriber<S extends EventSink> {
  sink: S;
  uid: string | null;
}

/**
 * A set of SSE subscribers, each pinned to a uid, with a fan-out that only
 * reaches subscribers in the originating event's tenant.
 */
export class TenantEventBus<S extends EventSink = EventSink> {
  private readonly subscribers = new Set<Subscriber<S>>();

  /**
   * Register `sink` as a subscriber for tenant `uid` (null on the Mac edition /
   * shared-token demo). Returns an unsubscribe function to call on disconnect —
   * identity is per-entry, so the same sink may register more than once and
   * each registration is removed independently.
   */
  add(sink: S, uid: string | null): () => void {
    const entry: Subscriber<S> = { sink, uid };
    this.subscribers.add(entry);
    return () => {
      this.subscribers.delete(entry);
    };
  }

  /** Live subscriber count (diagnostics / tests). */
  get size(): number {
    return this.subscribers.size;
  }

  /**
   * Fan `event` out to every subscriber in `origin`'s tenant.
   *
   * `origin` is the uid of the home scope the event came from: a signed-in
   * cloud account's uid when the event was produced inside that account's
   * request/turn scope, or null when it came from the global/background scope
   * (idle/reflect schedulers, orchestrator hub) or the single-tenant Mac
   * edition. A dead connection that throws on write is skipped, not fatal —
   * it is removed by its own close handler.
   */
  broadcast(event: unknown, origin: string | null): void {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const sub of this.subscribers) {
      if (!sameTenant(sub.uid, origin)) continue;
      try {
        sub.sink.write(data);
      } catch {
        /* dead conn — dropped when its close handler fires */
      }
    }
  }
}
