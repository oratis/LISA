/**
 * The active dream scope (AsyncLocalStorage).
 *
 * A reflective pass runs inside `dreamScope.run(scope, …)` so that, without
 * threading a parameter through the agent loop:
 *  - autonomy runs recorded inside the pass are linked to the dream;
 *  - soul-git commits made inside the pass carry a `[dream:<id>]` stamp (and
 *    `reconsider:<ids>` when the user's reconsider notes were injected), so a
 *    dream can tell its own commits from a concurrent chat's;
 *  - the reconsider block is claimed into exactly this pass.
 *
 * This module must stay dependency-free: soul/git.ts and autonomy/runs.ts
 * import it, and reve/record.ts imports both of them.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface DreamScope {
  id: string;
  trigger: string;
  /** AutonomyRun ids recorded inside this pass. */
  runIds: string[];
  /** Outcomes of those runs, in order. */
  runOutcomes: string[];
  /** Reconsider request ids injected into this pass. */
  reconsiderIds: string[];
}

export const dreamScope = new AsyncLocalStorage<DreamScope>();

/** The kill switch: LISA_REVE_DREAMS=0 / false / off turns dream capture off. */
export function dreamsEnabled(): boolean {
  const v = process.env.LISA_REVE_DREAMS?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}

/** Dreams begun in THIS process and not yet ended (reconsider claim recovery). */
const activeDreams = new Set<string>();

export function markDreamActive(id: string, active: boolean): void {
  if (active) activeDreams.add(id);
  else activeDreams.delete(id);
}

export function dreamIsActive(id: string): boolean {
  return activeDreams.has(id);
}

export function currentDream(): DreamScope | undefined {
  return dreamScope.getStore();
}

/** Called by recordAutonomyRun for every run; links it to the active dream. */
export function noteAutonomyRunInDream(id: string, outcome: string): string | undefined {
  const scope = dreamScope.getStore();
  if (!scope) return undefined;
  scope.runIds.push(id);
  scope.runOutcomes.push(outcome);
  return scope.id;
}

/**
 * Suffix for soul-git commit subjects made inside a dream:
 * ` [dream:d-… reconsider:rc-a,rc-b]`, or "" outside a dream.
 */
export function dreamCommitTrailer(): string {
  const scope = dreamScope.getStore();
  if (!scope) return "";
  const rc = scope.reconsiderIds.length ? ` reconsider:${scope.reconsiderIds.join(",")}` : "";
  return ` [dream:${scope.id}${rc}]`;
}

const TRAILER_RE = /\s\[dream:(d-\d{8}T\d{9}-[0-9a-f]{8})(?:\sreconsider:([a-z0-9,-]+))?\]$/;

/** Parse the trailer back out of a commit subject. */
export function parseDreamTrailer(subject: string): {
  base: string;
  dreamId?: string;
  reconsider?: string[];
} {
  const m = TRAILER_RE.exec(subject);
  if (!m) return { base: subject };
  return {
    base: subject.slice(0, m.index),
    dreamId: m[1],
    reconsider: m[2] ? m[2].split(",").filter(Boolean) : undefined,
  };
}
