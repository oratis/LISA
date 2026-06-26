import type Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { proxyAwareFetch } from "../proxy-bootstrap.js";
import { withStreamRetry } from "./stream-retry.js";
import type { StoredMessage } from "../types.js";
import type {
  Provider,
  ProviderResult,
  ProviderRunOpts,
} from "./types.js";

export class OpenAIProvider implements Provider {
  readonly name = "openai";
  private client: OpenAI;

  constructor(opts: { apiKey?: string; baseURL?: string } = {}) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      fetch: proxyAwareFetch,
    });
  }

  async runTurn(opts: ProviderRunOpts): Promise<ProviderResult> {
    const messages = anthropicToOpenAI(opts.systemPrompt, opts.messages);
    const tools = opts.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as Record<string, unknown>,
      },
    }));

    // Per-attempt state lives inside the retry closure so it resets cleanly on
    // a transient empty-stream retry (see withStreamRetry).
    return withStreamRetry({ signal: opts.signal }, async (markEmitted) => {
      const stream = await this.client.chat.completions.create(
        {
          model: opts.model,
          messages,
          tools: tools.length ? tools : undefined,
          max_tokens: opts.maxTokens ?? 16_000,
          stream: true,
          stream_options: { include_usage: true },
        },
        // Per-request options; `signal` aborts the in-flight HTTP stream
        // (the SDK then throws APIUserAbortError).
        { signal: opts.signal },
      );

      let text = "";
      const toolCalls = new Map<
        number,
        { id: string; name: string; args: string }
      >();
      let finish = "stop";
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (choice?.delta?.content) {
          markEmitted();
          text += choice.delta.content;
          opts.handlers?.onTextDelta?.(choice.delta.content);
        }
        if (choice?.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const idx = tc.index;
            if (!toolCalls.has(idx)) {
              toolCalls.set(idx, { id: "", name: "", args: "" });
            }
            const acc = toolCalls.get(idx)!;
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) acc.args += tc.function.arguments;
          }
        }
        if (choice?.finish_reason) finish = choice.finish_reason;
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? 0;
          outputTokens = chunk.usage.completion_tokens ?? 0;
          const details = chunk.usage.prompt_tokens_details as
            | { cached_tokens?: number }
            | undefined;
          cacheReadTokens = details?.cached_tokens ?? 0;
        }
      }

      const content: Anthropic.ContentBlock[] = [];
      if (text) {
        content.push({ type: "text", text, citations: null } as Anthropic.TextBlock);
      }
      for (const tc of toolCalls.values()) {
        let parsed: unknown = {};
        try {
          parsed = tc.args ? JSON.parse(tc.args) : {};
        } catch {
          parsed = { _raw: tc.args };
        }
        content.push({
          type: "tool_use",
          id: tc.id || `call_${tc.name}_${Math.random().toString(36).slice(2)}`,
          name: tc.name,
          input: parsed,
        } as Anthropic.ToolUseBlock);
      }

      return {
        content,
        stopReason: finish === "tool_calls" ? "tool_use" : "end_turn",
        usage: {
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens: 0,
        },
      };
    });
  }
}

function anthropicToOpenAI(
  systemPrompt: string,
  messages: StoredMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
  ];
  for (const msg of messages) {
    if (msg.role === "user") {
      const content = msg.content;
      if (typeof content === "string") {
        out.push({ role: "user", content });
        continue;
      }
      const textBlocks: string[] = [];
      const toolResults: { id: string; content: string; isError: boolean }[] =
        [];
      for (const block of content) {
        if (block.type === "text") {
          textBlocks.push(block.text);
        } else if (block.type === "tool_result") {
          const text =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .map((b) => (b.type === "text" ? b.text : ""))
                    .join("\n")
                : "";
          toolResults.push({
            id: block.tool_use_id,
            content: text,
            isError: block.is_error ?? false,
          });
        }
      }
      if (textBlocks.length) {
        out.push({ role: "user", content: textBlocks.join("\n") });
      }
      for (const tr of toolResults) {
        out.push({
          role: "tool",
          tool_call_id: tr.id,
          content: tr.isError ? `[error] ${tr.content}` : tr.content,
        });
      }
    } else {
      const content = msg.content;
      if (typeof content === "string") {
        out.push({ role: "assistant", content });
        continue;
      }
      const textParts: string[] = [];
      const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] =
        [];
      for (const block of content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        }
      }
      const assistant: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam =
        {
          role: "assistant",
          content: textParts.join("\n") || null,
        };
      if (toolCalls.length) assistant.tool_calls = toolCalls;
      out.push(assistant);
    }
  }
  return out;
}
