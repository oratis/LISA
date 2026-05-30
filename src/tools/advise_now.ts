/**
 * advise_now — on-demand pull of the advisor's current suggestions.
 *
 * "Lisa, what should I know about what's running?" → she runs the cross-agent
 * detectors against the live session snapshot and reports what clears the
 * relevance bar (throttle/dedup bypassed for an explicit ask). Structural
 * only — never conversation content.
 */

import type { ToolDefinition } from "../types.js";
import { getCurrentHub } from "../integrations/current-hub.js";
import { adviseNow, loadAdvisorState, formatDigest } from "../advisor/engine.js";

export const adviseNowTool: ToolDefinition<Record<string, never>, string> = {
  name: "advise_now",
  description:
    "Check what's worth knowing across all running agents (Claude Code, Codex, …) right now: " +
    "stuck sessions, same-repo conflicts, permission prompts, cost spikes, finished work. " +
    "Returns a short list of suggestions, or '(nothing notable)'. Use when the user asks " +
    "what's going on with their agents, or whether anything needs attention.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute() {
    const hub = getCurrentHub();
    if (!hub) {
      return "(agent monitoring isn't active — start the web server with `lisa serve --web`)";
    }
    const sessions = hub.list();
    if (sessions.length === 0) return "(no agents are active right now)";
    const state = await loadAdvisorState().catch(() => undefined);
    const suggestions = adviseNow({ sessions, now: Date.now() }, state);
    if (suggestions.length === 0) {
      return `(${sessions.length} agent session(s) active, nothing notable — all progressing normally)`;
    }
    return formatDigest(suggestions);
  },
};
