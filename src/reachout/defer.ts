/**
 * Deferred deliveries — pushes held back by quiet hours, released when the
 * window ends.
 *
 * In memory on purpose: holding a notice on disk would mean writing its title
 * and body there, and the ledger's promise is that reach-out never does. The
 * cost is that a restart during quiet hours loses the held push (the in-app
 * copy was already delivered when the gate decided).
 */
import type { ReachOutChannel } from "./types.js";

export interface DeferredDelivery {
  /** Ledger id of the notice. */
  id: string;
  /** Epoch ms the delivery becomes due. */
  dueAt: number;
  channels: ReachOutChannel[];
  /**
   * Called when due. Returns the channels actually released, or a new `dueAt`
   * to wait longer (quiet hours moved). Must not throw.
   */
  release: (now: Date) => Promise<{ released: ReachOutChannel[] } | { retryAt: number }>;
}

export interface DeferQueueOpts {
  now?: () => Date;
  /** Poll interval while anything is queued. */
  tickMs?: number;
  /** Hard cap; the oldest entry is dropped beyond it. */
  max?: number;
  log?: (m: string) => void;
}

export class DeferQueue {
  private items: DeferredDelivery[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private readonly now: () => Date;
  private readonly tickMs: number;
  private readonly max: number;
  private readonly log: (m: string) => void;

  constructor(opts: DeferQueueOpts = {}) {
    this.now = opts.now ?? (() => new Date());
    this.tickMs = opts.tickMs ?? 60_000;
    this.max = opts.max ?? 200;
    this.log = opts.log ?? (() => {});
  }

  size(): number {
    return this.items.length;
  }

  enqueue(item: DeferredDelivery): void {
    this.items.push(item);
    if (this.items.length > this.max) {
      const dropped = this.items.shift();
      if (dropped) this.log(`[reachout] deferred queue full — dropped ${dropped.id}`);
    }
    this.arm();
  }

  /** Release everything due at `now`. Returns how many entries were released. */
  async flushDue(now: Date = this.now()): Promise<number> {
    if (this.flushing) return 0;
    this.flushing = true;
    let released = 0;
    try {
      const due = this.items.filter((i) => i.dueAt <= now.getTime());
      for (const item of due) {
        let outcome: { released: ReachOutChannel[] } | { retryAt: number };
        try {
          outcome = await item.release(now);
        } catch (err) {
          this.log(`[reachout] deferred release failed for ${item.id}: ${(err as Error).message}`);
          outcome = { released: [] };
        }
        if ("retryAt" in outcome && outcome.retryAt > now.getTime()) {
          item.dueAt = outcome.retryAt;
          continue;
        }
        this.items = this.items.filter((i) => i !== item);
        released++;
      }
    } finally {
      this.flushing = false;
    }
    if (this.items.length === 0) this.stop();
    return released;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private arm(): void {
    if (this.timer || this.tickMs <= 0) return;
    this.timer = setInterval(() => void this.flushDue(), this.tickMs);
    if (this.timer.unref) this.timer.unref();
  }
}

let shared: DeferQueue | null = null;

/** The process-wide queue used when a caller does not inject one. */
export function sharedDeferQueue(): DeferQueue {
  if (!shared) shared = new DeferQueue();
  return shared;
}
