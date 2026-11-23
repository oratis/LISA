import { EventEmitter } from "node:events";
import { defaultSystemPresenceProbe, type SystemPresenceProbe } from "./system-presence.js";

/**
 * Process-wide IdleWatcher. Surfaces (web POST /chat, channel router, REPL)
 * call `tick()` on every user input. The watcher fires `idle` once when the
 * gap between now and last tick exceeds `idleMs`. After firing it stays
 * quiet until the next tick — we don't keep firing every minute.
 *
 * When a `presenceProbe` is available (default: macOS `IOHIDSystem` idle +
 * `IOConsoleLocked`), active unlocked OS HID input resets the countdown even
 * while the user works in other apps (e.g. VS Code / Cursor), preventing false
 * "away" dreams. Locked screens never suppress idle firing.
 *
 * No backpressure: if the runner takes longer than `idleMs`, the watcher
 * does NOT re-arm until tick() is called again.
 */
export class IdleWatcher extends EventEmitter {
  private lastActivityAt: number;
  private timer?: NodeJS.Timeout;
  private fired = false;
  private running = false;
  private checking = false;
  private readonly idleMs: number;
  private readonly checkIntervalMs: number;
  private readonly presenceProbe: SystemPresenceProbe | null;

  constructor(opts: {
    idleMs: number;
    checkIntervalMs?: number;
    presenceProbe?: SystemPresenceProbe | null;
  }) {
    super();
    this.idleMs = opts.idleMs;
    this.checkIntervalMs = opts.checkIntervalMs ?? 60_000;
    this.presenceProbe =
      opts.presenceProbe === null ? null : (opts.presenceProbe ?? defaultSystemPresenceProbe);
    this.lastActivityAt = Date.now();
    this.setMaxListeners(32);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastActivityAt = Date.now();
    this.timer = setInterval(() => void this.checkNow(), this.checkIntervalMs);
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

  /** Evaluate idle + optional OS presence once. Returns true if `idle` fired. */
  async checkNow(): Promise<boolean> {
    if (this.fired || this.checking) return false;
    if (this.idleFor() < this.idleMs) return false;
    if (this.presenceProbe) {
      this.checking = true;
      try {
        const presence = await this.presenceProbe().catch(() => ({ available: false as const }));
        if (this.fired || this.idleFor() < this.idleMs) return false;
        if (
          presence.available &&
          !presence.locked &&
          typeof presence.idleMs === "number" &&
          Number.isFinite(presence.idleMs) &&
          presence.idleMs >= 0 &&
          presence.idleMs < this.idleMs
        ) {
          this.lastActivityAt = Math.max(this.lastActivityAt, Date.now() - presence.idleMs);
          return false;
        }
      } finally {
        this.checking = false;
      }
    }
    if (this.fired || this.idleFor() < this.idleMs) return false;
    this.fired = true;
    this.emit("idle", { idleMs: this.idleFor() });
    return true;
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
