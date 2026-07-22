import { EventEmitter } from "node:events";
import { scopedUid } from "./paths.js";

/**
 * Process-wide mood bus + a few lightweight agent-state pulses.
 *
 * The set_mood tool emits `mood` here and the web server (or any other
 * surface) subscribes to push it to the client. The agent loop also emits
 * `chat_start` / `chat_end` so external surfaces (web GUI, island widget)
 * can show a "thinking" indicator without subscribing to the per-turn
 * agent event stream.
 *
 * Decoupled from the agent loop so non-agent code (scheduled tasks,
 * heartbeats, channels) can also nudge the avatar.
 *
 * ── Mood STATE is per-tenant (B2) ────────────────────────────────────────
 * set_mood runs inside the caller's home scope, so the "current" slug is
 * stored under that scope's uid (scopedUid()). A signed-in cloud account gets
 * its own current mood; the Mac edition and all background/global work share
 * the one null scope. current() returns the mood of the CALLER's scope, so a
 * fresh /events, /chat or island-ping connection is served ITS OWN account's
 * mood on connect — never whatever another tenant last set. The `mood` EVENT
 * is still a single process-wide emit; the web server's tenant-aware fan-out
 * (web/event-bus.ts) is what filters who receives it.
 */
class MoodBus extends EventEmitter {
  private globalMood = "neutral"; // Mac edition / background / shared token
  private readonly moodByUid = new Map<string, string>(); // signed-in accounts

  set(slug: string): void {
    const uid = scopedUid();
    if (uid) this.moodByUid.set(uid, slug);
    else this.globalMood = slug;
    this.emit("mood", slug);
  }

  /** The current mood of the CALLER's home scope (defaults to "neutral"). */
  current(): string {
    const uid = scopedUid();
    return uid ? this.moodByUid.get(uid) ?? "neutral" : this.globalMood;
  }

  /** Drop a tenant's stored mood — called when its account is deleted (B2). */
  forget(uid: string): void {
    this.moodByUid.delete(uid);
  }

  /** Agent loop entered a turn — surfaces switch to "thinking" indicator. */
  chatStart(): void {
    this.emit("chat_start");
  }

  /** Agent loop exited — surfaces clear the "thinking" indicator. */
  chatEnd(): void {
    this.emit("chat_end");
  }
}

export const moodBus = new MoodBus();
moodBus.setMaxListeners(64);
