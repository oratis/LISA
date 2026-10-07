import type Anthropic from "@anthropic-ai/sdk";
import type { StoredMessage, ToolDefinition } from "../types.js";

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ProviderResult {
  content: Anthropic.ContentBlock[];
  stopReason: string;
  usage: ProviderUsage;
  /**
   * The model that actually served the call, when it can differ from the one
   * requested (a fallback chain sets it). Unset ⇒ the requested model.
   */
  model?: string;
}

export interface ProviderStreamHandlers {
  onTextDelta?: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
}

export interface ProviderRunOpts {
  model: string;
  systemPrompt: string;
  tools: ToolDefinition[];
  messages: StoredMessage[];
  maxTokens?: number;
  thinking?: boolean;
  compaction?: boolean;
  /** Thinking-depth / token-spend lever (Anthropic `output_config.effort`).
   *  Omitted ⇒ API default ("high"). Subagents use "low" for cheap work. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  handlers?: ProviderStreamHandlers;
  signal?: AbortSignal;
}

export interface Provider {
  readonly name: string;
  /**
   * Every model a call may be served by, for a provider that can answer with
   * a model other than the requested one (a fallback chain). Unset ⇒ only the
   * requested model. The cost cap reserves for the dearest of them.
   */
  readonly models?: readonly string[];
  runTurn(opts: ProviderRunOpts): Promise<ProviderResult>;
}
