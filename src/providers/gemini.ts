/**
 * Google Gemini provider — translates Anthropic-style messages/tools to and
 * from Gemini's `Content[]` + `FunctionDeclaration[]` shape.
 *
 * Routing: model names starting with `gemini-` go through here. API key comes
 * from `GEMINI_API_KEY` (or `GOOGLE_API_KEY` as fallback — Google ships under
 * both). A `LISA_BASE_URL` override can point at a Gemini-compatible relay
 * (uncommon, mostly for testing).
 *
 * Translation summary:
 *   Anthropic role "user" + text       → Content{role:"user", parts:[{text}]}
 *   Anthropic role "user" + tool_result → Content{role:"user", parts:[{functionResponse:{...}}]}
 *   Anthropic role "assistant" + text  → Content{role:"model", parts:[{text}]}
 *   Anthropic role "assistant" + tool_use → Content{role:"model", parts:[{functionCall:{...}}]}
 *   System prompt                      → config.systemInstruction
 *
 * Tool definitions go in config.tools[0].functionDeclarations using the
 * `parametersJsonSchema` field (standard JSON Schema, no Gemini-Schema
 * conversion needed).
 *
 * Limitations vs Anthropic / OpenAI:
 *   - No prompt caching equivalent; cacheReadTokens always 0.
 *   - Gemini may emit only one functionCall per turn for some models; we
 *     handle multiple if present, but don't rely on it.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { Content, GoogleGenAI, Part } from "@google/genai";
import type { StoredMessage } from "../types.js";
import type { Provider, ProviderResult, ProviderRunOpts } from "./types.js";

export class GeminiProvider implements Provider {
  readonly name = "gemini";
  // Lazily constructed on first runTurn so that merely importing the provider
  // registry (Anthropic-only users, unit tests) doesn't load @google/genai.
  private client: GoogleGenAI | null = null;
  private readonly clientOpts: { apiKey?: string; baseURL?: string };

  constructor(opts: { apiKey?: string; baseURL?: string } = {}) {
    this.clientOpts = opts;
  }

  private async getClient(): Promise<GoogleGenAI> {
    if (!this.client) {
      const { GoogleGenAI } = await import("@google/genai");
      // GoogleGenAI doesn't accept a custom fetch; relies on undici globally,
      // which proxy-bootstrap.ts has already configured. baseURL is supported
      // via httpOptions.
      this.client = new GoogleGenAI({
        apiKey: this.clientOpts.apiKey,
        ...(this.clientOpts.baseURL
          ? { httpOptions: { baseUrl: this.clientOpts.baseURL } }
          : {}),
      });
    }
    return this.client;
  }

  async runTurn(opts: ProviderRunOpts): Promise<ProviderResult> {
    const client = await this.getClient();
    const contents = anthropicToGemini(opts.messages);
    const tools =
      opts.tools.length > 0
        ? [
            {
              functionDeclarations: opts.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parametersJsonSchema: t.inputSchema,
              })),
            },
          ]
        : undefined;

    const stream = await client.models.generateContentStream({
      model: opts.model,
      contents,
      config: {
        // Aborts the in-flight request (the SDK then throws an abort error).
        abortSignal: opts.signal,
        systemInstruction: opts.systemPrompt,
        tools,
        maxOutputTokens: opts.maxTokens ?? 16_000,
      },
    });

    let text = "";
    const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    let finish = "STOP";
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const chunk of stream) {
      const cand = chunk.candidates?.[0];
      if (cand?.finishReason) finish = cand.finishReason;
      const parts = cand?.content?.parts ?? [];
      for (const p of parts) {
        if (typeof p.text === "string" && p.text.length > 0) {
          text += p.text;
          opts.handlers?.onTextDelta?.(p.text);
        }
        if (p.functionCall) {
          toolCalls.push({
            id: p.functionCall.id ?? `call_${p.functionCall.name}_${Math.random().toString(36).slice(2)}`,
            name: p.functionCall.name ?? "",
            args: (p.functionCall.args ?? {}) as Record<string, unknown>,
          });
        }
      }
      // usageMetadata is on the final chunk
      const usage = chunk.usageMetadata;
      if (usage) {
        inputTokens = usage.promptTokenCount ?? 0;
        outputTokens = usage.candidatesTokenCount ?? 0;
      }
    }

    const content: Anthropic.ContentBlock[] = [];
    if (text) {
      content.push({ type: "text", text, citations: null } as Anthropic.TextBlock);
    }
    for (const tc of toolCalls) {
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input: tc.args,
      } as Anthropic.ToolUseBlock);
    }

    // Gemini finish reasons: STOP, MAX_TOKENS, SAFETY, RECITATION, OTHER, BLOCKLIST,
    // PROHIBITED_CONTENT, SPII, MALFORMED_FUNCTION_CALL, IMAGE_SAFETY.
    // Tool calls are signaled by the presence of functionCall parts, NOT a
    // distinct finishReason — so we infer from toolCalls.length.
    const stopReason = toolCalls.length > 0 ? "tool_use" : "end_turn";

    return {
      content,
      stopReason,
      usage: {
        inputTokens,
        outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    };
  }
}

/**
 * Translate Lisa's Anthropic-style message history into Gemini's Content[]
 * shape. Handles text, tool_use (assistant), and tool_result (user) blocks.
 *
 * Edge cases handled:
 *   - Empty user text + only tool_results → produces user message with
 *     functionResponse parts (Gemini accepts this).
 *   - Multi-modal images (Anthropic image blocks) → mapped to inlineData
 *     parts when base64 source is present; URL sources skipped (Gemini
 *     wants base64 or fileData).
 */
function anthropicToGemini(messages: StoredMessage[]): Content[] {
  const out: Content[] = [];
  for (const msg of messages) {
    const isUser = msg.role === "user";
    const parts: Part[] = [];
    const content = msg.content;
    if (typeof content === "string") {
      parts.push({ text: content });
    } else {
      for (const block of content) {
        if (block.type === "text") {
          if (block.text) parts.push({ text: block.text });
        } else if (block.type === "tool_use") {
          // Assistant tool_use → Gemini functionCall
          parts.push({
            functionCall: {
              id: block.id,
              name: block.name,
              args: (block.input ?? {}) as Record<string, unknown>,
            },
          });
        } else if (block.type === "tool_result") {
          // User tool_result → Gemini functionResponse
          // The tool_result content can be a string or an array of blocks.
          // Gemini's response is an object, so we wrap text in {output: text}
          // or {error: text}.
          const resultText =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .map((b) => (b.type === "text" ? b.text : ""))
                    .join("\n")
                : "";
          parts.push({
            functionResponse: {
              id: block.tool_use_id,
              name: extractToolNameFromHistory(messages, block.tool_use_id) ?? "unknown",
              response: block.is_error
                ? { error: resultText }
                : { output: resultText },
            },
          });
        } else if (block.type === "image" && "source" in block) {
          // Best-effort image translation. Skip if not base64.
          const src = block.source as { type?: string; data?: string; media_type?: string };
          if (src?.type === "base64" && src.data && src.media_type) {
            parts.push({
              inlineData: { mimeType: src.media_type, data: src.data },
            });
          }
        }
      }
    }
    if (parts.length === 0) continue;
    out.push({ role: isUser ? "user" : "model", parts });
  }
  return out;
}

/**
 * Walk back through history to find the tool_use block whose id matches
 * `toolUseId`, return its name. Gemini's functionResponse needs the name,
 * not just the id — Anthropic's tool_result only carries the id.
 */
function extractToolNameFromHistory(
  messages: StoredMessage[],
  toolUseId: string,
): string | null {
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const content = msg.content;
    if (typeof content === "string") continue;
    for (const block of content) {
      if (block.type === "tool_use" && block.id === toolUseId) {
        return block.name;
      }
    }
  }
  return null;
}
