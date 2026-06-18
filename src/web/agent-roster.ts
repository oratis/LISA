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

/**
 * Display label for a roster row. Prefers the git branch — far more meaningful
 * than a worktree-hash cwd basename like "2cffa8" — with the ubiquitous
 * "claude/" prefix stripped; falls back to the project name. Pure +
 * self-contained (the island injects this function's source; the
 * injection-safety test guards it, so no imports / closure refs).
 *
 * (Claude Code's human-written session TITLE isn't in the transcript JSONL the
 * observer reads, so the branch is the best title-like label we actually have.)
 */
export function rosterLabel(s: RosterSession): string {
  const a = s.activity;
  const branch =
    a && typeof a === "object" ? (a as { gitBranch?: unknown }).gitBranch : undefined;
  if (typeof branch === "string" && branch) {
    return branch.replace(/^claude\//, "");
  }
  return s.project;
}

/**
 * One-line structural summary of a session's Tier-2 activity — what it's *doing*
 * and how far along, never conversation content: a pending-permission warning,
 * else "✗ error · turn N · Mk tok · $ cmd · Tool file". Returns "" when there's
 * no activity. Pure + self-contained (island injects this source; the
 * injection-safety test guards it — no imports, no named const-arrows).
 */
export function formatActivity(s: RosterSession): string {
  const a = s.activity as
    | {
        pendingPermission?: unknown;
        lastError?: unknown;
        turnCount?: unknown;
        tokens?: { input?: unknown; output?: unknown };
        lastCommandName?: unknown;
        lastTools?: unknown;
        filesTouched?: unknown;
      }
    | undefined;
  if (!a || typeof a !== "object") return "";
  if (typeof a.pendingPermission === "string" && a.pendingPermission) {
    return "⚠ wants to run " + a.pendingPermission;
  }
  const bits: string[] = [];
  if (typeof a.lastError === "string" && a.lastError) bits.push("✗ " + a.lastError);

  const prog: string[] = [];
  if (typeof a.turnCount === "number" && a.turnCount > 0) prog.push("turn " + a.turnCount);
  if (a.tokens && typeof a.tokens === "object") {
    const tin = typeof a.tokens.input === "number" ? a.tokens.input : 0;
    const tout = typeof a.tokens.output === "number" ? a.tokens.output : 0;
    const tot = tin + tout;
    if (tot > 0) prog.push(tot >= 1000 ? Math.round(tot / 1000) + "k tok" : tot + " tok");
  }
  if (prog.length) bits.push(prog.join(" "));

  if (typeof a.lastCommandName === "string" && a.lastCommandName) bits.push("$ " + a.lastCommandName);

  const tools = Array.isArray(a.lastTools) ? (a.lastTools as unknown[]) : [];
  const tool = tools.length ? String(tools[tools.length - 1]) : "";
  const files = Array.isArray(a.filesTouched) ? (a.filesTouched as unknown[]) : [];
  const file = files.length ? String(files[files.length - 1]).split("/").pop() || "" : "";
  if (tool && file) bits.push(tool + " " + file);
  else if (tool) bits.push(tool);
  else if (file) bits.push(file);

  return bits.join(" · ");
}
