import type { ToolDefinition } from "../types.js";
import { memoryTool } from "../memory/tool.js";
import { memorySearchTool } from "../memory/search_tool.js";
import { skillManageTool } from "../skills/tool.js";
import {
  soulFeelTool,
  soulJournalTool,
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
import { setMoodTool } from "./set_mood.js";
import { writeTool } from "./write.js";

export interface ToolRegistryOptions {
  includeVoice?: boolean;
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
  ];
  if (opts.includeVoice) {
    tools.push(speakTool as ToolDefinition, transcribeTool as ToolDefinition);
  }
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return tools;
}

export const READ_ONLY_TOOL_NAMES = new Set([
  "read",
  "grep",
  "ls",
  "memory_search",
]);

export function readOnlySubset(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.filter((t) => READ_ONLY_TOOL_NAMES.has(t.name));
}
