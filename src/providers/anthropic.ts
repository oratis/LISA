import Anthropic from "@anthropic-ai/sdk";
import { proxyAwareFetch } from "../proxy-bootstrap.js";
import type {
  Provider,
  ProviderResult,
  ProviderRunOpts,
} from "./types.js";

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(opts: { apiKey?: string; authToken?: string; baseURL?: string } = {}) {
    // proxyAwareFetch passes through cleanly when no proxy is installed;
    // when one is, it re-injects Content-Type for proxies (Clash et al)
    // that strip response headers through CONNECT tunnels.
    // baseURL overrides the default https://api.anthropic.com — used to
    // route through an Anthropic-compatible proxy (one-api, openrouter,
    // self-hosted relay) when direct access is blocked.
    // authToken sends `Authorization: Bearer …` instead of the default
    // `x-api-key` header — the sanctioned path for an Anthropic-compatible
    // LLM gateway / proxy (matches Claude Code's ANTHROPIC_AUTH_TOKEN). When
    // set it takes precedence over apiKey, so callers pass one or the other.
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      authToken: opts.authToken,
      baseURL: opts.baseURL,
      fetch: proxyAwareFetch,
    });
  }

  async runTurn(opts: ProviderRunOpts): Promise<ProviderResult> {
    const messages = withCacheBreakpoint(opts.messages);
    const tools = opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));

    const params: Anthropic.MessageCreateParamsStreaming = {
      model: opts.model,
      max_tokens: opts.maxTokens ?? 16_000,
      system: [
        { type: "text", text: opts.systemPrompt, cache_control: { type: "ephemeral" } },
      ],
      tools,
      messages,
      stream: true,
    };
    if (opts.thinking) {
      params.thinking = { type: "adaptive" };
    }
    const extras: { betas?: string[]; context_management?: object } = {};
    if (opts.compaction) {
      extras.betas = ["compact-2026-01-12"];
      extras.context_management = { edits: [{ type: "compact_20260112" }] };
    }

    const onText = (delta: string) => opts.handlers?.onTextDelta?.(delta);
    const onThinking = (delta: string) =>
      opts.handlers?.onThinkingDelta?.(delta);

    // Second argument is the SDK's per-request options; `signal` aborts the
    // in-flight HTTP stream (the SDK then throws APIUserAbortError).
    const requestOpts = { signal: opts.signal };

    let message: Anthropic.Message;
    if (opts.compaction) {
      const stream = this.client.beta.messages.stream(
        {
          ...params,
          ...extras,
        } as Anthropic.Beta.MessageCreateParamsStreaming,
        requestOpts,
      );
      if (opts.handlers?.onTextDelta) stream.on("text", onText);
      if (opts.handlers?.onThinkingDelta) stream.on("thinking", onThinking);
      message = (await stream.finalMessage()) as unknown as Anthropic.Message;
    } else {
      const stream = this.client.messages.stream(params, requestOpts);
      if (opts.handlers?.onTextDelta) stream.on("text", onText);
      if (opts.handlers?.onThinkingDelta) stream.on("thinking", onThinking);
      message = await stream.finalMessage();
    }
    return {
      content: message.content as Anthropic.ContentBlock[],
      stopReason: message.stop_reason ?? "end_turn",
      usage: {
        inputTokens: message.usage?.input_tokens ?? 0,
        outputTokens: message.usage?.output_tokens ?? 0,
        cacheReadTokens: message.usage?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: message.usage?.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

function withCacheBreakpoint(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;
  const out = messages.slice();
  const last = out[out.length - 1]!;
  if (typeof last.content === "string") return out;
  const content = last.content as Anthropic.ContentBlockParam[];
  if (content.length === 0) return out;
  const cloned = content.map((block, idx) => {
    if (idx !== content.length - 1) return block;
    if (
      block.type === "text" ||
      block.type === "tool_result" ||
      block.type === "image" ||
      block.type === "document"
    ) {
      return { ...block, cache_control: { type: "ephemeral" as const } };
    }
    return block;
  });
  out[out.length - 1] = { ...last, content: cloned };
  return out;
}
