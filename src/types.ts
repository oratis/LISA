import type Anthropic from "@anthropic-ai/sdk";

export type Role = "user" | "assistant";

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: Anthropic.Tool.InputSchema;
  /**
   * MCP-compatible behavior hints. These are metadata for UX/policy inputs,
   * never proof that an untrusted tool is safe.
   */
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  execute(input: TInput, ctx: ToolContext): Promise<TOutput>;
  renderResultForModel?(result: TOutput): string;
}

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  log: (msg: string) => void;
  /**
   * Set by the agent loop. soul_object calls this to register an
   * architectural objection that must be surfaced in Lisa's reply
   * before the turn is considered closed. (Phase 2.1)
   */
  onObjection?: (o: { reason: string; refusing: boolean; userRequestSummary: string }) => void;
  /**
   * The execution world filesystem/shell tools act on (H1, see
   * docs/PLAN_HARNESS_ALIGNMENT_v1.0.md §2). Unset means the host's own disk
   * and shell — swapping it (sandboxed, per-tenant, remote) redirects every
   * fs/shell tool at once without touching tool code.
   *
   * Tools read this through `capsOf(ctx)` from src/capabilities/, never
   * directly, so the local default is applied in exactly one place.
   */
  caps?: import("./capabilities/types.js").Capabilities;
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
    | "info"
    | "system_prompt_rebuilt";
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  isError?: boolean;
  message?: string;
}
