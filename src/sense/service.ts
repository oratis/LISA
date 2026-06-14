/**
 * SenseService (PLAN_SENSE §2.2) — the resident loop that owns ambient sources,
 * decoupled from chat. Each source self-gates on consent every cycle, so the
 * service simply starts them all and lets ungranted ones no-op; `stopAll()` is
 * for shutdown. This is the registration point S2-voice plugs into next.
 */
import type { SenseEvent, SenseSource } from "./types.js";

export class SenseService {
  private readonly sources: SenseSource[] = [];
  private started = false;

  register(source: SenseSource): void {
    this.sources.push(source);
  }

  /** Start every registered source. Idempotent. Sources gate on consent. */
  async start(emit: (e: SenseEvent) => void): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const s of this.sources) {
      try {
        await s.start(emit);
      } catch {
        // one bad source must not take down the others / the server
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const s of this.sources) {
      try {
        await s.stop();
      } catch {
        // ignore
      }
    }
    this.started = false;
  }
}
