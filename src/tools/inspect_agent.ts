/**
 * inspect_agent (vibe-coding) — the deep view of ONE observed session, where
 * list_agents is the one-line-each roster. Full structural activity for the
 * matched session: state + reason, branch, turn count, every tool it has run,
 * every file it has touched, last command, pending permission, error, tokens.
 *
 * PRIVACY: structural metadata only — never conversation content (file PATHS
 * and tool NAMES, not contents). For what a repo actually changed, use
 * repo_digest / review_diff against its cwd.
 */
import type { ToolDefinition } from "../types.js";
import { getCurrentHub } from "../integrations/current-hub.js";
import type { AgentSession } from "../integrations/types.js";

interface InspectInput {
  /** Session id (or a prefix), or a project name, to inspect. */
  target: string;
}

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

/** Pure: full structural detail for one session. Exported for tests. */
export function formatDetail(s: AgentSession, now: number): string {
  const a = s.activity;
  const lines: string[] = [];
  lines.push(`${s.project} · ${s.agent} · ${s.sessionId}`);
  lines.push(`  state: ${s.state}${s.stateReason ? ` (${s.stateReason})` : ""} · last active ${ago(s.lastMtime, now)}`);
  if (s.cwd) lines.push(`  cwd: ${s.cwd}`);
  if (a?.gitBranch) lines.push(`  branch: ${a.gitBranch}`);
  if (typeof a?.turnCount === "number") lines.push(`  turns: ${a.turnCount}`);
  if (a?.pendingPermission) lines.push(`  ⏳ waiting on permission: ${a.pendingPermission}`);
  if (a?.lastCommandName) lines.push(`  last command: ${a.lastCommandName}`);
  if (a?.lastTools && a.lastTools.length) lines.push(`  tools: ${a.lastTools.join(" → ")}`);
  if (a?.filesTouched && a.filesTouched.length) {
    lines.push(`  files touched (${a.filesTouched.length}):`);
    for (const f of a.filesTouched.slice(0, 15)) lines.push(`    ${f}`);
    if (a.filesTouched.length > 15) lines.push(`    … +${a.filesTouched.length - 15} more`);
  }
  if (a?.tokens) lines.push(`  tokens: ${a.tokens.input} in / ${a.tokens.output} out`);
  if (a?.lastError) lines.push(`  error: ${a.lastError}`);
  return lines.join("\n");
}

function matches(s: AgentSession, target: string): boolean {
  const t = target.toLowerCase();
  return (
    s.sessionId.toLowerCase().startsWith(t) ||
    s.sessionId.toLowerCase() === t ||
    s.project.toLowerCase() === t ||
    s.project.toLowerCase().includes(t)
  );
}

export const inspectAgentTool: ToolDefinition<InspectInput, string> = {
  name: "inspect_agent",
  description:
    "Deep-dive one observed agent session (by session id / prefix, or project name): its full " +
    "structural activity — state + reason, git branch, turn count, every tool it ran, all files it " +
    "touched, last command, pending permission, errors, token usage. Use when the user asks 'what is " +
    "<session/project> doing in detail'. list_agents is the roster; this is one session. Structural " +
    "metadata only — never conversation content.",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: "Session id (or prefix) or project name to inspect." },
    },
    required: ["target"],
    additionalProperties: false,
  },
  async execute(input) {
    const hub = getCurrentHub();
    if (!hub) return "(agent monitoring isn't active — start the web server with `lisa serve --web`)";
    const target = (input.target ?? "").trim();
    if (!target) return "(give a session id or project name to inspect)";
    const now = Date.now();
    const all = hub.list();
    const hits = all.filter((s) => matches(s, target));
    if (hits.length === 0) {
      const names = all.map((s) => `${s.project} (${s.sessionId.slice(0, 8)})`).slice(0, 10).join(", ");
      return `(no observed session matches "${target}". Active: ${names || "none"})`;
    }
    if (hits.length > 1) {
      // Disambiguate, but still detail the most recently active one.
      hits.sort((a, b) => b.lastMtime - a.lastMtime);
      const head = `(${hits.length} match "${target}"; showing the most recent — narrow by session id)\n`;
      return head + formatDetail(hits[0]!, now);
    }
    return formatDetail(hits[0]!, now);
  },
};
