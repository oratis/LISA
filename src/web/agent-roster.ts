/**
 * Pure client-side reducer for the multi-agent monitor (Dispatch D4a).
 *
 * The island previously tracked Claude Code sessions only. These functions are
 * the generic, agent-agnostic logic that maintains a roster across ALL agents
 * (claude-code / codex / opencode / aider / git / shell / takoapi). They are
 * the TESTED logic the UI runs: island.ts injects their source into the page
 * (`${mergeAgentSession}`), so the browser executes exactly this code rather
 * than a drifting copy.
 *
 * CONSTRAINT: keep these fully self-contained (no imports, no module-scope
 * refs, only browser globals like Date/Array) so source-injection works.
 *
 * `lastMtime` may be epoch-ms (SSE `agent_session_update`) or an ISO string
 * (the `/api/agents/sessions` fetch); `new Date(x)` handles both.
 */

export interface RosterSession {
  agent?: string;
  sessionId: string;
  project: string;
  state: string;
  stateReason?: string;
  lastMtime: number | string;
  cwd?: string;
  activity?: unknown;
}

/**
 * Upsert `s` into `list` (identity = agent + sessionId) and drop sessions
 * outside the active window. Returns a NEW array. Pure.
 */
export function mergeAgentSession(
  list: RosterSession[],
  s: RosterSession,
  nowMs: number,
  windowMs: number,
): RosterSession[] {
  // Inlined key (no named const-arrow) so the compiled source stays free of
  // build-tool name-helpers and source-injection into the island works. The
  // injection-safety test guards this.
  const k = (s.agent || "agent") + "::" + s.sessionId;
  const cutoff = nowMs - windowMs;
  const out = list.filter((x) => (x.agent || "agent") + "::" + x.sessionId !== k);
  out.push(s);
  return out.filter((x) => new Date(x.lastMtime).getTime() >= cutoff);
}

/**
 * "Loudest signal wins" aggregate state across recent sessions, for the pill
 * dot: error > waiting > working; null if nothing recent/active. Pure.
 */
export function aggregateAgentState(
  list: RosterSession[],
  nowMs: number,
  windowMs: number,
): string | null {
  const cutoff = nowMs - windowMs;
  const recent = list.filter((x) => new Date(x.lastMtime).getTime() >= cutoff);
  if (recent.length === 0) return null;
  if (recent.some((x) => x.state === "error")) return "error";
  if (recent.some((x) => x.state === "waiting")) return "waiting";
  if (recent.some((x) => x.state === "working")) return "working";
  return null;
}
