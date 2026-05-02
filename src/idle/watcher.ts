import { EventEmitter } from "node:events";

/**
 * Process-wide IdleWatcher. Surfaces (web POST /chat, channel router, REPL)
 * call `tick()` on every user input. The watcher fires `idle` once when the
 * gap between now and last tick exceeds `idleMs`. After firing it stays
 * quiet until the next tick — we don't keep firing every minute.
 *
 * No backpressure: if the runner takes longer than `idleMs`, the watcher
 * does NOT re-arm until tick() is called again.
 */
export class IdleWatcher extends EventEmitter {
  private lastActivityAt: number;
  private timer?: NodeJS.Timeout;
  private fired = false;
  private running = false;
  private readonly idleMs: number;
  private readonly checkIntervalMs: number;

  constructor(opts: { idleMs: number; checkIntervalMs?: number }) {
    super();
    this.idleMs = opts.idleMs;
    this.checkIntervalMs = opts.checkIntervalMs ?? 60_000;
    this.lastActivityAt = Date.now();
    this.setMaxListeners(32);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastActivityAt = Date.now();
    this.timer = setInterval(() => this.check(), this.checkIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.running = false;
  }

  /** Call on every user input from any surface. */
  tick(): void {
    this.lastActivityAt = Date.now();
    this.fired = false;
  }

  /** Returns ms since last activity. */
  idleFor(): number {
    return Date.now() - this.lastActivityAt;
  }

  private check(): void {
    if (this.fired) return;
    if (this.idleFor() < this.idleMs) return;
    this.fired = true;
    this.emit("idle", { idleMs: this.idleFor() });
  }
}

let singleton: IdleWatcher | null = null;

/**
 * Get the process-wide IdleWatcher. The first caller's idleMs wins (subsequent
 * calls just return the existing instance). `start()` must be called explicitly.
 */
export function getIdleWatcher(idleMs: number): IdleWatcher {
  if (!singleton) {
    singleton = new IdleWatcher({ idleMs });
  }
  return singleton;
}
