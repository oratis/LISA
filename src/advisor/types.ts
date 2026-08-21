/**
 * Advisor (L5 ADVISE) — types.
 *
 * The advisor turns cross-agent observation into periodic, proactive
 * suggestions. Its one hard problem is not being annoying, so everything is
 * organized around the relevance bar + throttle + dedup (see engine.ts).
 *
 * See docs/ORCHESTRATOR_PLAN.md §5b.
 */

import type { AgentSession } from "../integrations/types.js";

/**
 * Every category a detector can actually emit.
 *
 * Declared as a runtime tuple (not a bare type union) so a test can check it
 * against what detectors.ts really produces. A union member with no detector
 * is a promise the product never keeps, and it leaks into the docs as a
 * feature that does not exist — `repeated_failure` sat here unimplemented and
 * did exactly that. Note tsconfig excludes *.test.ts, so a type-level pin in a
 * test would be inert; this has to be checkable at runtime.
 */
export const SUGGESTION_CATEGORIES = [
  "stuck",
  "conflict",
  "cost_spike",
  "ready",
  "idle",
] as const;

export type SuggestionCategory = (typeof SUGGESTION_CATEGORIES)[number];

/** How loudly a suggestion wants to be surfaced. */
export type Urgency = "info" | "notice" | "urgent";

/** A concrete action LISA can offer to take. A suggestion without one is
 *  considered non-actionable and won't clear the relevance bar. */
export interface SuggestedAction {
  label: string; // "Approve", "Cancel", "Open", "Serialize", "Look"
  kind: "approve" | "cancel" | "open" | "serialize" | "look" | "dispatch";
  /** Opaque arg the action handler needs (sessionId, cwd, …). */
  arg?: string;
}

export interface Suggestion {
  /** Stable dedup key — same underlying condition → same id. */
  id: string;
  category: SuggestionCategory;
  urgency: Urgency;
  /** One-line, user-facing. Structural — no conversation content. */
  text: string;
  action?: SuggestedAction;
  /** Computed relevance score (urgency × novelty × actionability). */
  score: number;
  /** A hash of the underlying condition; re-surface only when it changes. */
  conditionHash: string;
  /** When this was generated (epoch ms). */
  ts: number;
}

/** Persisted advisor memory (~/.lisa/advisor-state.json). */
export interface AdvisorState {
  /** id → last time we surfaced it + the condition hash then. */
  surfaced: Record<string, { ts: number; conditionHash: string }>;
  /** id → number of times the user dismissed it (down-weights category). */
  dismissals: Record<string, number>;
  /** category → dismissal count, for learning what to stop saying. */
  categoryDismissals: Partial<Record<SuggestionCategory, number>>;
  /** last time ANY non-urgent digest was surfaced (throttle). */
  lastDigestAt: number;
}

export function emptyAdvisorState(): AdvisorState {
  return {
    surfaced: {},
    dismissals: {},
    categoryDismissals: {},
    lastDigestAt: 0,
  };
}

/** Input snapshot for the detectors. */
export interface AdvisorInput {
  sessions: AgentSession[];
  now: number;
  /** Count of actionable desires with nothing running (drives "idle"). */
  pendingDesireCount?: number;
}

/** What the engine decided to do with this run's candidates. */
export interface AdvisorDecision {
  /** Cleared the bar + throttle/dedup → surface to the user. */
  surface: Suggestion[];
  /** Generated but suppressed (logged to journal, not shown). */
  suppressed: Suggestion[];
}
