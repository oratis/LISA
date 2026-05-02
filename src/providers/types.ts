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
  handlers?: ProviderStreamHandlers;
  signal?: AbortSignal;
}

export interface Provider {
  readonly name: string;
  runTurn(opts: ProviderRunOpts): Promise<ProviderResult>;
}
