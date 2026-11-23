/**
 * advise_now — on-demand pull of the advisor's current suggestions, plus optional
 * Dispatch D3 capability routing advice when given a `task`.
 *
 * "Lisa, what should I know about what's running?" → she runs the cross-agent
 * detectors against the live session snapshot and reports what clears the
 * relevance bar (throttle/dedup bypassed for an explicit ask). Structural
 * only — never conversation content.
 */

import type { ToolDefinition } from "../types.js";
import { getCurrentHub } from "../integrations/current-hub.js";
import { adviseNow, loadAdvisorState, formatDigest } from "../advisor/engine.js";
import {
  formatCapabilityRecommendation,
  recommendAgentForTask,
} from "../orchestrator/capabilities.js";

interface AdviseNowInput {
  /** Optional task description to also get a capability-based agent routing recommendation. */
  task?: string;
}

export const adviseNowTool: ToolDefinition<AdviseNowInput, string> = {
  name: "advise_now",
  description:
    "Check what's worth knowing across all running agents (Claude Code, Codex, Cursor, Gemini CLI, …) " +
    "right now: stuck sessions, same-repo conflicts, permission prompts, cost spikes, finished work. " +
    "Optionally pass `task` to also get a capability-based backend recommendation with rationale. " +
    "Returns a short list of suggestions, or '(nothing notable)'. Use when the user asks what's going " +
    "on with their agents, whether anything needs attention, or which agent to dispatch a task to.",
  inputSchema: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "Optional task description to recommend the best-suited coding agent backend.",
      },
    },
    additionalProperties: false,
  },
  async execute(input) {
    const hub = getCurrentHub();
    const sessions = hub ? hub.list() : [];
    const taskText = typeof input?.task === "string" ? input.task.trim() : "";

    let routingSection = "";
    if (taskText) {
      const busyAgents = sessions
        .filter((s) => s.state === "working" || s.state === "waiting")
        .map((s) => s.agent);
      const rec = recommendAgentForTask(taskText, undefined, { busyAgents });
      routingSection = formatCapabilityRecommendation(rec);
    }

    if (!hub) {
      const msg = "(agent monitoring isn't active — start the web server with `lisa serve --web`)";
      return routingSection ? `${routingSection}\n\n${msg}` : msg;
    }
    if (sessions.length === 0) {
      const msg = "(no agents are active right now)";
      return routingSection ? `${routingSection}\n\n${msg}` : msg;
    }
    const state = await loadAdvisorState().catch(() => undefined);
    const suggestions = adviseNow({ sessions, now: Date.now() }, state);
    const advisorSection =
      suggestions.length === 0
        ? `(${sessions.length} agent session(s) active, nothing notable — all progressing normally)`
        : formatDigest(suggestions);

    return routingSection ? `${routingSection}\n\n${advisorSection}` : advisorSection;
  },
};
