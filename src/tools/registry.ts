import type { ToolDefinition } from "../types.js";
import { memoryTool } from "../memory/tool.js";
import { memorySearchTool } from "../memory/search_tool.js";
import { adviseNowTool } from "./advise_now.js";
import { listAgentsTool } from "./list_agents.js";
import { inspectAgentTool } from "./inspect_agent.js";
import { repoDigestTool } from "./repo_digest.js";
import { reviewDiffTool } from "./review_diff.js";
import { runChecksTool } from "./run_checks.js";
import { prStatusTool } from "./pr_status.js";
import { dispatchAgentTool } from "./dispatch_agent.js";
import { runOnPlanTool } from "./run_on_plan.js";
import { dispatchStatusTool } from "./dispatch_status.js";
import { scheduledDispatchTool } from "./scheduled_dispatch.js";
import { compareAgentsTool } from "./compare_agents.js";
import { githubLinkTool } from "./github_link.js";
import { githubTool } from "./github.js";
import { npmInfoTool } from "./npm_info.js";
import { mcpTool } from "./mcp.js";
import { signalAgentTool } from "./signal_agent.js";
import { agentRecapTool } from "./agent_recap.js";
import { skillManageTool } from "../skills/tool.js";
import {
  desireCloseTool,
  desireProgressTool,
  soulDiffTool,
  soulFeelTool,
  soulHistoryTool,
  soulJournalTool,
  soulObjectTool,
  soulPatchTool,
  soulReadTool,
} from "../soul/tools.js";
import { speakTool, transcribeTool } from "../voice/tool.js";
import { applyPatchTool } from "./apply_patch.js";
import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { grepTool } from "./grep.js";
import { lsTool } from "./ls.js";
import { readTool } from "./read.js";
import { redeployTool } from "./redeploy.js";
import { setMoodTool } from "./set_mood.js";
import { webFetchTool } from "./web_fetch.js";
import { webSearchTool } from "./web_search.js";
import { takoapiTool } from "./takoapi.js";
import { writeTool } from "./write.js";

export interface ToolRegistryOptions {
  includeVoice?: boolean;
  /**
   * Extra tools merged into the registry — typically the approved
   * executable skills loaded from ~/.lisa/skills/<slug>/tool.js
   * (Phase 3.1). Conflicts (same .name as a builtin) are dropped with
   * a warning by the caller, not here.
   */
  extra?: ToolDefinition[];
}

export function buildToolRegistry(opts: ToolRegistryOptions = {}): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    readTool as ToolDefinition,
    writeTool as ToolDefinition,
    editTool as ToolDefinition,
    applyPatchTool as ToolDefinition,
    bashTool as ToolDefinition,
    grepTool as ToolDefinition,
    lsTool as ToolDefinition,
    skillManageTool as ToolDefinition,
    memoryTool as ToolDefinition,
    memorySearchTool as ToolDefinition,
    setMoodTool as ToolDefinition,
    soulPatchTool as ToolDefinition,
    soulJournalTool as ToolDefinition,
    soulReadTool as ToolDefinition,
    soulFeelTool as ToolDefinition,
    soulHistoryTool as ToolDefinition,
    soulDiffTool as ToolDefinition,
    soulObjectTool as ToolDefinition,
    desireProgressTool as ToolDefinition,
    desireCloseTool as ToolDefinition,
    webFetchTool as ToolDefinition,
    webSearchTool as ToolDefinition,
    takoapiTool as ToolDefinition,
    redeployTool as ToolDefinition,
    // Orchestration (docs/ORCHESTRATOR_PLAN.md): observe → advise → dispatch → control.
    listAgentsTool as ToolDefinition,
    inspectAgentTool as ToolDefinition,
    repoDigestTool as ToolDefinition,
    reviewDiffTool as ToolDefinition,
    runChecksTool as ToolDefinition,
    prStatusTool as ToolDefinition,
    adviseNowTool as ToolDefinition,
    dispatchAgentTool as ToolDefinition,
    runOnPlanTool as ToolDefinition,
    dispatchStatusTool as ToolDefinition,
    scheduledDispatchTool as ToolDefinition,
    compareAgentsTool as ToolDefinition,
    githubLinkTool as ToolDefinition,
    githubTool as ToolDefinition,
    npmInfoTool as ToolDefinition,
    mcpTool as ToolDefinition,
    signalAgentTool as ToolDefinition,
    agentRecapTool as ToolDefinition,
  ];
  if (opts.includeVoice) {
    tools.push(speakTool as ToolDefinition, transcribeTool as ToolDefinition);
  }
  if (opts.extra && opts.extra.length > 0) {
    const seen = new Set(tools.map((t) => t.name));
    for (const t of opts.extra) {
      if (seen.has(t.name)) continue; // builtin wins; caller logged the conflict
      tools.push(t);
      seen.add(t.name);
    }
  }
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return tools;
}

export const READ_ONLY_TOOL_NAMES = new Set([
  "read",
  "grep",
  "ls",
  "memory_search",
  "soul_history",
  "soul_diff",
  "web_fetch",
  "web_search",
  "agent_recap",
]);

export function readOnlySubset(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.filter((t) => READ_ONLY_TOOL_NAMES.has(t.name));
}

/**
 * Tools that must NOT be available to self-driven autonomous runs (desire
 * heartbeats, idle reflection / Reve). These runs execute unattended on a timer with
 * prompts that Lisa wrote herself — if an indirect prompt injection (e.g. via
 * web_fetch content) plants a malicious actionable desire, these are the tools
 * that would turn it into persistent code execution. Soul / memory / journal /
 * skill tools stay available: autonomous time is for self-work, not ops.
 *
 * User-defined heartbeat tasks (~/.lisa/heartbeat.json) keep the full toolset —
 * those prompts are authored by the user, same trust as typing into the REPL.
 *
 * Escape hatch: LISA_AUTONOMOUS_FULL_TOOLS=1 restores the old behavior.
 */
export const AUTONOMOUS_BLOCKED_TOOL_NAMES = new Set([
  "bash",
  "write",
  "edit",
  "apply_patch",
  "redeploy",
  "task",
  "dispatch_agent",
  "run_on_plan",
  "signal_agent",
  "scheduled_dispatch",
  "compare_agents",
  "run_checks",
  "github",
  "mcp",
  // takoapi calls spend the user's TAKO_KEY and send data to a remote agent —
  // not something an unattended/remote-origin run should do on its own.
  "takoapi",
]);

export function autonomousSubset(tools: ToolDefinition[]): ToolDefinition[] {
  if (process.env.LISA_AUTONOMOUS_FULL_TOOLS === "1") return tools;
  return tools.filter((t) => !AUTONOMOUS_BLOCKED_TOOL_NAMES.has(t.name));
}

/**
 * Tools that must NOT be reachable from remote-origin surfaces (IM channels:
 * Telegram / Discord / Slack / Feishu / iMessage / webhook) by default.
 * A channel message comes from whoever can reach the bot — with an empty
 * allow-list that can be anyone, and even with one it's a remote, replayable
 * surface. Mutating fs / shell / process-spawning / GitHub-writing tools turn
 * a single hostile message into local code execution, so they're off unless
 * the channel entry opts in with `"unsafeFullTools": true`.
 *
 * skill_manage is also blocked: a remotely planted skill becomes persistent
 * prompt material for later full-tool local sessions.
 */
export const REMOTE_BLOCKED_TOOL_NAMES = new Set([
  ...AUTONOMOUS_BLOCKED_TOOL_NAMES,
  "skill_manage",
  // dispatch_status surfaces the raw output of dispatched agents — read-only,
  // but richer content than the structural observers and not for remote-origin
  // (channel) callers. NOT autonomous-blocked: an autonomous run may read the
  // result of work it dispatched.
  "dispatch_status",
]);

export function remoteSafeSubset(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.filter((t) => !REMOTE_BLOCKED_TOOL_NAMES.has(t.name));
}
