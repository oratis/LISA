/**
 * list_agents (orchestrator OBSERVE — read side) — enumerate the CLI agent
 * sessions LISA is watching (Claude Code, Codex, …) with their structural
 * activity, so she can answer "what are my agents doing right now?" in chat.
 *
 * Fills the gap between:
 *   - advise_now  — only the relevance-gated *summary* ("10 active, nothing notable")
 *   - signal_agent — only LISA's OWN dispatched agents (the user's manual sessions
 *                    are observed but unreachable there)
 * The sidebar/island already show this data; this exposes it to the chat agent.
 *
 * PRIVACY: structural metadata only — state, project, git branch, tool/command
 * NAMES, file PATHS, counts, error strings. Never a prompt, a reply, or full
 * command arguments. Same boundary the parser privacy tests assert.
 */

import type { ToolDefinition } from "../types.js";
import { getCurrentHub } from "../integrations/current-hub.js";
import type { AgentSession } from "../integrations/types.js";

const STATE_RANK: Record<string, number> = {
  error: 0,
  waiting: 1,
  working: 2,
  done: 3,
  idle: 4,
  unknown: 5,
};

function ago(ms: number, now: number): string {
  const d = Math.max(0, now - ms);
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

/** One session → a readable, structural-only line. Pure, for display + tests. */
export function formatSessionLine(s: AgentSession, now: number): string {
  const a = s.activity;
  const bits: string[] = [];
  if (a?.gitBranch) bits.push(`@${a.gitBranch}`);
  if (a?.pendingPermission) bits.push(`⏳ needs permission: ${a.pendingPermission}`);
  else if (a?.lastCommandName) bits.push(`$ ${a.lastCommandName}`);
  else if (a?.lastTools && a.lastTools.length) bits.push(a.lastTools.slice(-3).join("→"));
  if (a?.lastError) bits.push(`error: ${a.lastError}`);
  if (a?.filesTouched && a.filesTouched.length) {
    const f = a.filesTouched
      .slice(-2)
      .map((p) => p.split("/").pop() ?? p)
      .join(", ");
    bits.push(`files: ${f}`);
  }
  const detail = bits.length ? " · " + bits.join(" · ") : "";
  return `• [${s.state}] ${s.project} (${s.agent}, ${ago(s.lastMtime, now)} ago)${detail}`;
}

export const listAgentsTool: ToolDefinition<Record<string, never>, string> = {
  name: "list_agents",
  description:
    "List the CLI agent sessions LISA is observing right now (Claude Code, Codex, …) with their " +
    "structural activity: state (working/waiting/error/idle), project, git branch, last tool/command " +
    "NAME, files touched, pending permission, errors. Use when the user asks what their agents are " +
    "doing, what's running, or 'what is <agent> up to'. Structural metadata only — never conversation " +
    "content; to see what a repo actually changed, read its `git log`. For LISA's OWN dispatched " +
    "agents (start/stop) use signal_agent; for a relevance-gated summary use advise_now.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute() {
    const hub = getCurrentHub();
    if (!hub) {
      return "(agent monitoring isn't active — start the web server with `lisa serve --web`)";
    }
    const now = Date.now();
    const sessions = hub.list();
    if (sessions.length === 0) return "(no agents are active right now)";
    const sorted = sessions.slice().sort((a, b) => {
      const ra = STATE_RANK[a.state] ?? 9;
      const rb = STATE_RANK[b.state] ?? 9;
      if (ra !== rb) return ra - rb;
      return b.lastMtime - a.lastMtime;
    });
    const head = `${sessions.length} agent session(s) observed (structural activity only):`;
    return [head, ...sorted.map((s) => formatSessionLine(s, now))].join("\n");
  },
};
