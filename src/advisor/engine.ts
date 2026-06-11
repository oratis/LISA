/**
 * Advisor engine — the anti-annoyance brain.
 *
 * Pure decision core: given this run's candidate suggestions + the persisted
 * advisor state + the clock, decide which clear the relevance bar AND the
 * throttle AND dedup, and which get suppressed (journaled, not shown). The
 * caller does the I/O (load/save state, surface the survivors).
 *
 * See docs/ORCHESTRATOR_PLAN.md §5b.3 for the anti-annoyance contract.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { LISA_HOME } from "../paths.js";
import { atomicWrite } from "../fs-utils.js";
import { withFileLock } from "../soul/lock.js";
import { runAllDetectors } from "./detectors.js";
import {
  emptyAdvisorState,
  type AdvisorDecision,
  type AdvisorInput,
  type AdvisorState,
  type Suggestion,
  type SuggestionCategory,
} from "./types.js";

// Tunables.
const URGENCY_WEIGHT = { info: 1, notice: 2, urgent: 4 } as const;
const MIN_SCORE = 1.5; // relevance bar: below this → journal, not user
const DIGEST_THROTTLE_MS = 3 * 60 * 60_000; // ≤1 non-urgent digest / 3h
const RE_ARM_MS = 24 * 60 * 60_000; // a standing condition can re-surface daily

export const ADVISOR_STATE_PATH = path.join(LISA_HOME, "advisor-state.json");

/** Relevance score = urgency × actionability × dismissal-decay. */
export function scoreSuggestion(s: Suggestion, state: AdvisorState): number {
  const urgency = URGENCY_WEIGHT[s.urgency];
  const actionability = s.action ? 1 : 0.5;
  const catDismissals = state.categoryDismissals[s.category] ?? 0;
  // Each dismissal of this category halves its pull (learns to shut up).
  const decay = 1 / (1 + catDismissals * 1.0);
  return urgency * actionability * decay;
}

/** Has this exact condition been surfaced recently (→ suppress as dup)? */
function isDuplicate(s: Suggestion, state: AdvisorState, now: number): boolean {
  const prev = state.surfaced[s.id];
  if (!prev) return false;
  if (prev.conditionHash !== s.conditionHash) return false; // condition changed → fresh
  return now - prev.ts < RE_ARM_MS;
}

/**
 * Pure decision. Returns the surface/suppress split AND the next state to
 * persist. Does not touch disk.
 */
export function decide(
  candidates: Suggestion[],
  state: AdvisorState,
  now: number,
): { decision: AdvisorDecision; nextState: AdvisorState } {
  const surface: Suggestion[] = [];
  const suppressed: Suggestion[] = [];

  // Score everything first.
  for (const c of candidates) c.score = scoreSuggestion(c, state);

  const withinThrottle = now - state.lastDigestAt < DIGEST_THROTTLE_MS;
  let surfacedAnyNonUrgent = false;

  for (const c of candidates) {
    // Dedup: same condition seen recently → suppress.
    if (isDuplicate(c, state, now)) {
      suppressed.push(c);
      continue;
    }
    if (c.urgency === "urgent") {
      // Urgent bypasses the bar + throttle — but still deduped above.
      surface.push(c);
      continue;
    }
    // Non-urgent must clear the relevance bar…
    if (c.score < MIN_SCORE) {
      suppressed.push(c);
      continue;
    }
    // …and the digest throttle.
    if (withinThrottle) {
      suppressed.push(c);
      continue;
    }
    surface.push(c);
    surfacedAnyNonUrgent = true;
  }

  // Build next state: record what we surfaced + advance the digest clock.
  const nextState: AdvisorState = {
    ...state,
    surfaced: { ...state.surfaced },
  };
  for (const s of surface) {
    nextState.surfaced[s.id] = { ts: now, conditionHash: s.conditionHash };
  }
  if (surfacedAnyNonUrgent) nextState.lastDigestAt = now;

  // Sort surfaced by score desc so the digest leads with what matters.
  surface.sort((a, b) => b.score - a.score);
  return { decision: { surface, suppressed }, nextState };
}

/** Record a user dismissal so the category fades over time. */
export function applyDismissal(
  state: AdvisorState,
  id: string,
  category: SuggestionCategory,
): AdvisorState {
  return {
    ...state,
    dismissals: { ...state.dismissals, [id]: (state.dismissals[id] ?? 0) + 1 },
    categoryDismissals: {
      ...state.categoryDismissals,
      [category]: (state.categoryDismissals[category] ?? 0) + 1,
    },
  };
}

/**
 * Persisted dismissal: load → applyDismissal → save, under the same state
 * lock advise() uses. Called by POST /api/advisor/dismiss when the user
 * ✕'es a suggestion on the island — this is what makes the "stop telling me
 * about X" learning loop real.
 */
export async function dismissSuggestion(
  id: string,
  category: SuggestionCategory,
  statePath: string = ADVISOR_STATE_PATH,
): Promise<void> {
  await withFileLock(statePath + ".lock", async () => {
    const state = await loadAdvisorState(statePath);
    await saveAdvisorState(applyDismissal(state, id, category), statePath);
  });
}

// ── I/O ─────────────────────────────────────────────────────────────────

export async function loadAdvisorState(
  p: string = ADVISOR_STATE_PATH,
): Promise<AdvisorState> {
  try {
    const raw = await fsp.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as Partial<AdvisorState>;
    return { ...emptyAdvisorState(), ...parsed };
  } catch {
    return emptyAdvisorState();
  }
}

export async function saveAdvisorState(
  state: AdvisorState,
  p: string = ADVISOR_STATE_PATH,
): Promise<void> {
  await atomicWrite(p, JSON.stringify(state, null, 2));
}

/**
 * Full advise cycle: detect → decide → persist. Returns the suggestions to
 * surface. Uses the soul lock so a heartbeat advise can't race a manual one.
 */
export async function advise(
  input: AdvisorInput,
  statePath: string = ADVISOR_STATE_PATH,
): Promise<AdvisorDecision> {
  return withFileLock(statePath + ".lock", async () => {
    const state = await loadAdvisorState(statePath);
    const candidates = runAllDetectors(input);
    const { decision, nextState } = decide(candidates, state, input.now);
    await saveAdvisorState(nextState, statePath);
    return decision;
  });
}

/**
 * On-demand ("pull") advice: run the detectors against the current snapshot
 * and return everything above the bar, sorted — WITHOUT the throttle/dedup
 * (the user explicitly asked, so don't suppress) and WITHOUT mutating state.
 * Used by the advise_now tool.
 */
export function adviseNow(input: AdvisorInput, state: AdvisorState = emptyAdvisorState()): Suggestion[] {
  const cands = runAllDetectors(input);
  for (const c of cands) c.score = scoreSuggestion(c, state);
  return cands
    .filter((c) => c.urgency === "urgent" || c.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score);
}

/** Render surfaced suggestions into one digest card (markdown-ish text). */
export function formatDigest(suggestions: Suggestion[]): string {
  if (suggestions.length === 0) return "";
  if (suggestions.length === 1) return suggestions[0]!.text;
  const lines = suggestions.map((s) => {
    const mark = s.urgency === "urgent" ? "⚠ " : "• ";
    return mark + s.text;
  });
  return "A few things across your agents:\n" + lines.join("\n");
}
