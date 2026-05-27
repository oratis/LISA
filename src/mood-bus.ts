import { EventEmitter } from "node:events";

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
 */
class MoodBus extends EventEmitter {
  private currentSlug = "neutral";

  set(slug: string): void {
    this.currentSlug = slug;
    this.emit("mood", slug);
  }

  current(): string {
    return this.currentSlug;
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
