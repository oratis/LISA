import type { Skill } from "../types.js";

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  author?: string;
}

export interface SlashCommand {
  name: string;
  description: string;
  body: string;
  source: string;
  argumentHint?: string;
}

export interface SubagentDefinition {
  name: string;
  description: string;
  body: string;
  source: string;
  tools?: string[];
  model?: string;
}

export interface HookSpec {
  event:
    | "PreToolUse"
    | "PostToolUse"
    | "Stop"
    | "SessionStart"
    | "SessionEnd"
    | "UserPromptSubmit";
  matcher?: string;
  command: string;
  timeout_ms?: number;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  root: string;
  commands: SlashCommand[];
  agents: SubagentDefinition[];
  skills: Skill[];
  hooks: HookSpec[];
  mcpServers: { name: string; command: string; args?: string[]; env?: Record<string, string> }[];
}
