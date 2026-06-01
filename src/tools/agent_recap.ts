/**
 * agent_recap (L6) — the cross-agent "while you were away" digest.
 *
 * Answers "what happened across all my agents since I left?" by synthesizing
 * the orchestrator journal (every observed session's state transitions over
 * time) into a readable, project-grouped recap: who ran where, what finished,
 * what errored, what's still going. Complements advise_now (relevance-gated
 * alerts, now) and list_agents (the current roster) with the temporal story —
 * including sessions that have since ended and dropped out of the live list.
 *
 * Structural metadata only (agent, project, state, tool/file names, errors) —
 * never prompts, replies, or file contents. Read-only.
 */

import type { ToolDefinition } from "../types.js";
import { eventsSince } from "../orchestrator/journal.js";
import { buildRecap, formatRecap } from "../orchestrator/recap.js";

interface RecapInput {
  /** Look back this many minutes (default 120, clamped 1–1440). */
  sinceMinutes?: number;
}

export const agentRecapTool: ToolDefinition<RecapInput, string> = {
  name: "agent_recap",
  description:
    "Summarize what happened across ALL the coding agents LISA observes (Claude Code, " +
    "Codex, OpenCode, Aider, GitHub PRs) over a recent time window — the cross-agent " +
    '"while you were away" recap. Use when the user asks what their agents did, what ' +
    "happened since they were gone, or for an end-of-session wrap-up. Groups by project " +
    "and reports what finished, errored, or is still running. Structural metadata only — " +
    "never conversation content. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      sinceMinutes: {
        type: "number",
        description: "Window to look back over, in minutes (default 120; max 1440).",
      },
    },
    additionalProperties: false,
  },
  async execute(input) {
    const mins = Math.max(1, Math.min(1440, Math.round(input.sinceMinutes ?? 120)));
    const now = Date.now();
    const sinceMs = now - mins * 60_000;
    const recap = buildRecap(eventsSince(sinceMs), sinceMs, now);
    const window = mins >= 60 ? `${Math.round(mins / 60)}h` : `${mins}m`;
    return `Cross-agent recap (last ${window}):\n${formatRecap(recap)}`;
  },
};
