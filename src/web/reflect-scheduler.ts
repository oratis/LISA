/**
 * Web-path reflection scheduling (PLAN_DESIRE_EVOLUTION_v1.0 §3 PR1).
 *
 * The web server is long-lived, so there is no "process exit" to hang
 * end-of-session reflection on — which is exactly why the web path historically
 * reflected *never*, and Lisa's desires never changed from web conversations.
 *
 * Instead we reflect when a stretch of conversation goes quiet: after
 * `debounceMs` of no user activity, once, provided the human actually said
 * something new since the last reflection. This module holds the pure decision
 * logic so it is unit-testable without a live server; the server owns the timer
 * and the side effects.
 */
import type { StoredMessage } from "../types.js";

/** Default quiet window before a web conversation is reflected on. Shorter than
 *  the 60-min "dream" idle on purpose — reflection should track the conversation's
 *  natural pauses, not wait an hour. Overridable via LISA_REFLECT_DEBOUNCE_MS. */
export const DEFAULT_REFLECT_DEBOUNCE_MS = 5 * 60_000;

/** How often the server re-evaluates whether to reflect. */
export const REFLECT_CHECK_INTERVAL_MS = 60_000;

export interface ReflectDecisionInput {
  /** User-role messages added since the last successful reflection (or startup). */
  newUserMessages: number;
  /** Milliseconds since the last user activity. */
  idleMs: number;
  /** Quiet-window threshold. */
  debounceMs: number;
  /** True when a reflection (or the idle "dream") is already running. */
  inFlight: boolean;
}

export interface ReflectDecision {
  shouldReflect: boolean;
  reason: string;
}

/**
 * Decide whether the web server should reflect right now. Pure.
 *
 * Reflect iff: nothing is in flight, the conversation has been quiet for at
 * least `debounceMs`, and the user has contributed at least one new message
 * since we last reflected. Counting *user* messages (not total) means Lisa's
 * own idle-injected "[while you were away]" notes never trigger a reflection on
 * her own monologue.
 */
export function decideReflect(input: ReflectDecisionInput): ReflectDecision {
  if (input.inFlight) return { shouldReflect: false, reason: "in-flight" };
  if (input.idleMs < input.debounceMs) {
    return { shouldReflect: false, reason: "not-quiet-yet" };
  }
  if (input.newUserMessages < 1) {
    return { shouldReflect: false, reason: "no-new-user-input" };
  }
  return {
    shouldReflect: true,
    reason: `quiet ${Math.round(input.idleMs / 1000)}s, ${input.newUserMessages} new user msg(s)`,
  };
}

/** Count user-role messages in a history. Robust to the history being replaced
 *  wholesale each turn — we compare counts, not indices, so truncation/compaction
 *  can't make us re-reflect old content. */
export function countUserMessages(history: readonly StoredMessage[]): number {
  let n = 0;
  for (const m of history) if (m.role === "user") n++;
  return n;
}
