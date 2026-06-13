/**
 * Recent agent-fleet recap, ready to inject into Lisa's self-driven runs
 * (PLAN_REVE_v1.0 R5). The orchestrator journal records what every agent did;
 * before this, that record was write-only — reflection and heartbeat never read
 * it. This composes journal + recap so Lisa can factor "what my fleet did" into
 * how she reflects and what she pursues.
 *
 * Returns null when there was no activity in the window, so callers can inject
 * conditionally. Structural metadata only (no prompts/replies/file contents).
 */
import { eventsSince } from "./journal.js";
import { buildRecap, formatRecap } from "./recap.js";

export function recentAgentRecap(
  windowMs: number = 2 * 60 * 60_000,
  now: number = Date.now(),
): string | null {
  const sinceMs = now - windowMs;
  const recap = buildRecap(eventsSince(sinceMs), sinceMs, now);
  if (recap.totalSessions === 0) return null;
  return formatRecap(recap);
}
