import { EventEmitter } from "node:events";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { homeForUid, lisaHome, scopedUid } from "./paths.js";

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
 * ── Mood is READABLE, not just writable ──────────────────────────────────
 * The avatar used to be a write-only channel: set_mood wrote here, the web
 * client rendered the portrait, and nothing ever carried the slug back into
 * Lisa's context — so asked "why are you happy?" she could only inspect her
 * emotion vector (a different system) and guess. `currentState()` is the read
 * side: prompt.ts puts it in the system prompt every turn and soul_read
 * surfaces it next to the emotions, so she can always name the face the user
 * is actually looking at. `by` records which KIND of turn set it, because the
 * bus is shared across every surface — an idle reflection or a background
 * agent can change the portrait a chat session never touched.
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
 *
 * ── …and it survives a restart ───────────────────────────────────────────
 * The slug is mirrored to `<scoped home>/current-mood.json` so a restarted
 * process doesn't silently snap the portrait back to neutral while the user
 * is still looking at the old one. Memory stays the source of truth; the file
 * is a best-effort mirror, hydrated lazily on first read per scope (sync, once
 * — current() is called from hot paths like the /events connect frame).
 */

/** File under the scoped Lisa home that mirrors the current mood. */
const MOOD_FILE = "current-mood.json";

/** Map key for the null (Mac / background / shared-token) scope. */
const GLOBAL_KEY = "__global__";

/** What a turn is labelled as when nothing called withMoodOrigin(). */
const DEFAULT_ORIGIN = "a chat turn";

export interface MoodState {
  /** kebab-case portrait slug (matches an asset in web/assets/lisa/). */
  slug: string;
  /** epoch ms when it was set; 0 = never set this run (the default face). */
  at: number;
  /** Coarse label of which kind of turn set it — "an idle turn", … */
  by: string;
}

const NEVER_SET: MoodState = { slug: "neutral", at: 0, by: "nobody" };

/**
 * Which kind of turn is currently running. runAgent() wraps every loop in one
 * of these, so set_mood can attribute the change without threading a session
 * id through every tool call.
 */
const originStore = new AsyncLocalStorage<string>();

/** Run `fn` with mood changes inside it attributed to `label`. */
export function withMoodOrigin<T>(label: string, fn: () => T): T {
  return originStore.run(label, fn);
}

/**
 * Human-readable age of a mood, bucketed. Deliberately coarse: it goes into
 * the system prompt, and the prompt fingerprint includes it — a bucket that
 * ticked every minute would churn the provider's prompt cache all day.
 */
export function moodAgeLabel(at: number, nowMs: number = Date.now()): string {
  if (at === 0) return "never";
  const min = Math.max(0, (nowMs - at) / 60_000);
  if (min < 5) return "moments ago";
  if (min < 60) return "within the last hour";
  if (min < 360) return "a few hours ago";
  if (min < 1440) return "earlier today";
  return "over a day ago";
}

class MoodBus extends EventEmitter {
  private readonly byScope = new Map<string, MoodState>();
  /** Scopes already checked against disk — negative results cached too. */
  private readonly hydrated = new Set<string>();

  set(slug: string): void {
    const key = scopeKey();
    const state: MoodState = {
      slug,
      at: Date.now(),
      by: originStore.getStore() ?? DEFAULT_ORIGIN,
    };
    this.byScope.set(key, state);
    this.hydrated.add(key);
    persist(state);
    this.emit("mood", slug);
  }

  /** The current mood slug of the CALLER's home scope (defaults to "neutral"). */
  current(): string {
    return this.currentState().slug;
  }

  /** The full record — slug plus when it was set and by what kind of turn. */
  currentState(): MoodState {
    const key = scopeKey();
    const known = this.byScope.get(key);
    if (known) return known;
    if (!this.hydrated.has(key)) {
      this.hydrated.add(key);
      const loaded = load();
      if (loaded) {
        this.byScope.set(key, loaded);
        return loaded;
      }
    }
    return NEVER_SET;
  }

  /** Drop a tenant's stored mood — called when its account is deleted (B2). */
  forget(uid: string): void {
    this.byScope.delete(uid);
    // Stay in `hydrated` with no entry: a later current() must NOT resurrect
    // the deleted account's face from a file whose unlink may have failed.
    this.hydrated.add(uid);
    try {
      fs.unlinkSync(path.join(homeForUid(uid), MOOD_FILE));
    } catch {
      // already gone (the whole home subtree is usually deleted with it)
    }
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

function scopeKey(): string {
  return scopedUid() ?? GLOBAL_KEY;
}

/**
 * Mirror to disk, fire-and-forget. Async on purpose: the hosted edition's home
 * is a gcsfuse mount shared by one event loop across tenants, and a stalled
 * writeFileSync there would freeze everyone's turn for a cosmetic write. The
 * cost is a tiny loss window if the process dies in the milliseconds after
 * set_mood — memory is the source of truth and the next set re-persists.
 */
function persist(state: MoodState): void {
  const file = path.join(lisaHome(), MOOD_FILE);
  void fs.promises.writeFile(file, JSON.stringify(state)).catch(() => {
    // best effort — a read-only or missing home costs persistence, not the turn
  });
}

function load(): MoodState | null {
  try {
    const raw = fs.readFileSync(path.join(lisaHome(), MOOD_FILE), "utf8");
    const parsed = JSON.parse(raw) as Partial<MoodState>;
    if (typeof parsed.slug !== "string" || !parsed.slug) return null;
    return {
      slug: parsed.slug,
      at: typeof parsed.at === "number" ? parsed.at : 0,
      by: typeof parsed.by === "string" ? parsed.by : "an earlier run",
    };
  } catch {
    return null;
  }
}

export const moodBus = new MoodBus();
moodBus.setMaxListeners(64);
