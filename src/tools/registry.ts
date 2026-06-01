import type { ToolDefinition } from "../types.js";
import { memoryTool } from "../memory/tool.js";
import { memorySearchTool } from "../memory/search_tool.js";
import { adviseNowTool } from "./advise_now.js";
import { listAgentsTool } from "./list_agents.js";
import { repoDigestTool } from "./repo_digest.js";
import { reviewDiffTool } from "./review_diff.js";
import { dispatchAgentTool } from "./dispatch_agent.js";
import { signalAgentTool } from "./signal_agent.js";
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
    redeployTool as ToolDefinition,
    // Orchestration (docs/ORCHESTRATOR_PLAN.md): observe → advise → dispatch → control.
    listAgentsTool as ToolDefinition,
    repoDigestTool as ToolDefinition,
    reviewDiffTool as ToolDefinition,
    adviseNowTool as ToolDefinition,
    dispatchAgentTool as ToolDefinition,
    signalAgentTool as ToolDefinition,
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
]);

export function readOnlySubset(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.filter((t) => READ_ONLY_TOOL_NAMES.has(t.name));
}
