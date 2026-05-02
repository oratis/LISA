import { EventEmitter } from "node:events";

/**
 * Process-wide mood bus. The set_mood tool emits the new mood here and the
 * web server (or any other surface) subscribes to push it to the client.
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
}

export const moodBus = new MoodBus();
moodBus.setMaxListeners(64);
