import type Anthropic from "@anthropic-ai/sdk";

export type Role = "user" | "assistant";

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: Anthropic.Tool.InputSchema;
  execute(input: TInput, ctx: ToolContext): Promise<TOutput>;
  renderResultForModel?(result: TOutput): string;
}

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  log: (msg: string) => void;
}

export type StoredMessage = Anthropic.MessageParam;

export interface SkillFrontmatter {
  name: string;
  description: string;
  version?: string;
  tags?: string[];
}

export interface Skill {
  frontmatter: SkillFrontmatter;
  body: string;
  path: string;
}

export interface SessionHeader {
  type: "session";
  id: string;
  version: 1;
  startedAt: string;
  cwd: string;
  model: string;
}

export type SessionEntry =
  | { type: "message"; ts: string; message: StoredMessage }
  | { type: "model_change"; ts: string; model: string }
  | { type: "reflection"; ts: string; summary: string };

export interface AgentEvent {
  type:
    | "turn_start"
    | "text_delta"
    | "thinking_delta"
    | "tool_call_start"
    | "tool_call_end"
    | "turn_end"
    | "error"
    | "info";
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  isError?: boolean;
  message?: string;
}
