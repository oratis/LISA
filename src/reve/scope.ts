/**
 * The active dream scope (AsyncLocalStorage).
 *
 * A reflective pass runs inside `dreamScope.run(scope, …)` so that, without
 * threading a parameter through the agent loop:
 *  - autonomy runs recorded inside the pass are linked to the dream;
 *  - soul-git commits made inside the pass carry a `[dream:<id>]` stamp (and
 *    `reconsider:<ids>` when the user's reconsider notes were injected), so a
 *    dream can tell its own commits from a concurrent chat's;
 *  - the reconsider notes shown to this pass are claimed by it alone, and
 *    acknowledged when it ends (see reconsider.ts);
 *  - a write to a home file made OUTSIDE a dream's scope while that dream is
 *    running (a concurrent chat's "remember X", a KB edit, a user revert) is
 *    noted against the dream, so the dream never offers to revert it.
 *
 * This module must stay dependency-free (Node built-ins only): fs-utils.ts,
 * soul/git.ts and autonomy/runs.ts import it, and reve/record.ts imports
 * them.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

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

/** Paths written outside one dream's scope while it ran (absolute, resolved). */
interface OutsideWrites {
  paths: Set<string>;
  /** More distinct paths than MAX_OUTSIDE_PATHS: treat every path as touched. */
  overflow: boolean;
}

/** Bound on the paths remembered per dream; past it the dream assumes all were touched. */
export const MAX_OUTSIDE_PATHS = 5000;

/**
 * Dreams begun in THIS process and not yet ended (reconsider claim recovery),
 * each with the writes made outside its scope since it began.
 */
const activeDreams = new Map<string, OutsideWrites>();

export function markDreamActive(id: string, active: boolean): void {
  if (active) {
    if (!activeDreams.has(id)) activeDreams.set(id, { paths: new Set(), overflow: false });
  } else activeDreams.delete(id);
}

export function dreamIsActive(id: string): boolean {
  return activeDreams.has(id);
}

/**
 * A home file is about to be written or removed (called from the shared write
 * paths: fs-utils atomicWrite, the KB and skill deletes, revert's removals).
 * Every active dream whose scope this call is NOT in notes the path, so its
 * record can mark a change to that file not revertible: the change may hold
 * someone else's write. Process-local: a write from another process (a CLI,
 * a launchd heartbeat) is not seen here. Never throws.
 */
export function noteHomeWrite(absPath: string): void {
  if (activeDreams.size === 0) return;
  const own = dreamScope.getStore()?.id;
  const p = path.resolve(absPath);
  for (const [id, w] of activeDreams) {
    if (id === own || w.overflow) continue;
    if (w.paths.size >= MAX_OUTSIDE_PATHS && !w.paths.has(p)) {
      w.overflow = true;
      w.paths.clear();
    } else w.paths.add(p);
  }
}

/** Was `absPath` written outside this dream's scope while it ran? */
export function writtenOutsideDream(id: string, absPath: string): boolean {
  const w = activeDreams.get(id);
  if (!w) return false;
  return w.overflow || w.paths.has(path.resolve(absPath));
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
