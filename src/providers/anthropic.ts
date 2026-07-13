import Anthropic from "@anthropic-ai/sdk";
import { proxyAwareFetch } from "../proxy-bootstrap.js";
import { withStreamRetry } from "./stream-retry.js";
import type {
  Provider,
  ProviderResult,
  ProviderRunOpts,
} from "./types.js";

/** Structural shape shared by `messages.stream` and `beta.messages.stream`. */
interface StreamLike {
  on(event: "text" | "thinking", cb: (delta: string) => void): unknown;
  finalMessage(): Promise<unknown>;
}

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

    // Cache the large, stable system prefix (soul + skills + memory) for 1h so it
    // stays warm across normal think-time gaps in a bursty personal session,
    // instead of paying a cold re-write every time the 5-min default expires. The
    // conversational tail (withCacheBreakpoint) stays at the cheaper 5-min default.
    // Heavy-continuous users can opt back to 5-min writes via LISA_CACHE_TTL=5m.
    // GA on Sonnet 4.6 / Opus 4.x — see docs/PLAN_MODEL_TUNING_v1.0.md.
    const systemCache: Anthropic.CacheControlEphemeral =
      process.env.LISA_CACHE_TTL === "5m"
        ? { type: "ephemeral" }
        : { type: "ephemeral", ttl: "1h" };

    const params: Anthropic.MessageCreateParamsStreaming = {
      model: opts.model,
      max_tokens: opts.maxTokens ?? 16_000,
      system: [
        { type: "text", text: opts.systemPrompt, cache_control: systemCache },
      ],
      tools,
      messages,
      stream: true,
    };
    if (opts.thinking) {
      params.thinking = { type: "adaptive" };
    }
    // Optional thinking-depth / token-spend lever (GA on Sonnet 4.6). Omitted ⇒
    // the API default of "high". Dispatched subagents pass "low" for cheap
    // parallel work; a global LISA_EFFORT can override for power users.
    // Gated by model: Claude Haiku 4.5 rejects output_config.effort with a hard
    // 400 ("This model does not support the effort parameter"). Subagents and
    // idle/reflect calls default to effort "low", so without this gate every one
    // of them routed to Haiku would fail outright (and the relay doesn't strip it).
    if (opts.effort && modelSupportsEffort(opts.model)) {
      (params as { output_config?: { effort?: string } }).output_config = {
        ...(params as { output_config?: { effort?: string } }).output_config,
        effort: opts.effort,
      };
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

    // Retry transient empty-stream failures ("request ended without sending any
    // chunks" and proxy-induced connection drops). The SDK's request-level
    // retries don't cover these — they're thrown while iterating a 200 stream —
    // so without this a momentary proxy/network blip surfaces as a hard error.
    // Safe because we only retry while no delta has been forwarded yet.
    const message = await withStreamRetry(
      { signal: opts.signal },
      async (markEmitted) => {
        const stream: StreamLike = opts.compaction
          ? (this.client.beta.messages.stream(
              { ...params, ...extras } as Anthropic.Beta.MessageCreateParamsStreaming,
              requestOpts,
            ) as unknown as StreamLike)
          : (this.client.messages.stream(params, requestOpts) as unknown as StreamLike);
        if (opts.handlers?.onTextDelta) {
          stream.on("text", (t) => {
            markEmitted();
            onText(t);
          });
        }
        if (opts.handlers?.onThinkingDelta) {
          stream.on("thinking", (t) => {
            markEmitted();
            onThinking(t);
          });
        }
        return (await stream.finalMessage()) as Anthropic.Message;
      },
    );
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

/**
 * Does MODEL accept the `output_config.effort` lever?
 *
 * Effort is GA on Sonnet 4.6 / Opus 4.x, but Claude Haiku 4.5
 * (`claude-haiku-4-5-*`) rejects it outright:
 *   400 invalid_request_error "This model does not support the effort parameter."
 * Subagents and idle/reflect calls default to effort "low", so every such call
 * routed to Haiku would hard-fail without this gate. Default-allow (Sonnet/Opus
 * and future families keep effort) and strip only the known-incompatible Haiku
 * family — matched case-insensitively on a substring so it covers dated ids
 * ("claude-haiku-4-5-20251001") and relayed aliases alike.
 */
export function modelSupportsEffort(model: string): boolean {
  return !/haiku/i.test(model);
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
