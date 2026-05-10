import type Anthropic from "@anthropic-ai/sdk";
import type {
  AgentEvent,
  StoredMessage,
  ToolDefinition,
} from "./types.js";
import type { Provider } from "./providers/types.js";

export interface ApprovalDecision {
  allow: boolean;
  reason?: string;
}

export type ApprovalCallback = (
  toolName: string,
  toolInput: unknown,
) => Promise<ApprovalDecision> | ApprovalDecision;

/**
 * Mid-session system-prompt hot-reload (Phase 1.1 of AUTONOMY_ROADMAP).
 *
 * If provided, the agent loop calls `rebuild()` at the top of every turn
 * after the first. If the returned `fingerprint` differs from the stored
 * one, the new `text` becomes the system prompt for the next provider call.
 * This lets soul_patch / skill_create / memory writes take effect within
 * the same conversation rather than only next session.
 *
 * Cost: one cheap fingerprint check per turn. When the fingerprint changes
 * the next provider call has a cache miss on the system prompt — accepted
 * cost for the agent actually experiencing her own self-update.
 */
export interface PromptHotReload {
  initialFingerprint: string;
  rebuild: () => Promise<{ text: string; fingerprint: string }>;
}

export interface RunAgentOptions {
  provider: Provider;
  systemPrompt: string;
  tools: ToolDefinition[];
  toolCtx: { cwd: string; signal: AbortSignal; log: (msg: string) => void };
  history: StoredMessage[];
  userMessage: string;
  userFiles?: Array<{ name: string; mediaType: string; data: string }>;
  model: string;
  maxTokens?: number;
  thinking?: boolean;
  compaction?: boolean;
  onEvent?: (event: AgentEvent) => void;
  onMessagePersist?: (message: StoredMessage) => Promise<void> | void;
  approval?: ApprovalCallback;
  preToolHook?: (
    name: string,
    input: unknown,
  ) => Promise<{ block?: string; rewriteResult?: string } | void>;
  postToolHook?: (
    name: string,
    input: unknown,
    result: string,
    isError: boolean,
  ) => Promise<{ rewriteResult?: string } | void>;
  maxIterations?: number;
  /** When set, the system prompt is rebuilt between turns if its source state changed. */
  hotReload?: PromptHotReload;
}

export interface RunAgentResult {
  finalText: string;
  history: StoredMessage[];
  iterations: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
}

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const {
    provider,
    systemPrompt,
    tools,
    toolCtx,
    onEvent,
    onMessagePersist,
    model,
    maxTokens = 16_000,
    thinking = false,
    compaction = false,
    maxIterations = 32,
  } = opts;

  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const messages: StoredMessage[] = [...opts.history];
  if (opts.userMessage || (opts.userFiles && opts.userFiles.length)) {
    const content: Anthropic.ContentBlockParam[] = [];
    if (opts.userMessage) {
      content.push({ type: "text", text: opts.userMessage });
    }
    for (const f of opts.userFiles ?? []) {
      const isImage = f.mediaType.startsWith("image/");
      if (isImage) {
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: f.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
            data: f.data,
          },
        });
      } else {
        // Non-image files: send as document block (supported for PDFs) or text
        content.push({
          type: "text",
          text: `[Attached file: ${f.name} (${f.mediaType}) — base64 data follows]\n${f.data}`,
        });
      }
    }
    const firstUser: StoredMessage = { role: "user", content };
    messages.push(firstUser);
    await onMessagePersist?.(firstUser);
  }

  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let finalText = "";
  let iterations = 0;
  let stopReason = "end_turn";

  let currentSystemPrompt = systemPrompt;
  let currentFingerprint = opts.hotReload?.initialFingerprint;

  while (iterations < maxIterations) {
    iterations++;

    // Mid-session prompt hot-reload (Phase 1.1). Skip on the very first turn —
    // the caller already supplied a fresh prompt. From turn 2 on, check whether
    // the prompt-influencing state changed (soul / skills / memory) and rebuild
    // if so. The next provider call will pay one cache miss on the system
    // prompt; this is the price of the agent actually experiencing her own
    // mid-session self-update.
    if (opts.hotReload && iterations > 1) {
      try {
        const next = await opts.hotReload.rebuild();
        if (next.fingerprint !== currentFingerprint) {
          currentSystemPrompt = next.text;
          currentFingerprint = next.fingerprint;
          onEvent?.({
            type: "system_prompt_rebuilt",
            message: `system prompt rebuilt (${next.text.length} bytes)`,
          });
        }
      } catch (err) {
        // Hot-reload is best-effort; never crash the agent loop on it.
        toolCtx.log(
          `[hot-reload] skipped: ${(err as Error).message.slice(0, 200)}`,
        );
      }
    }

    onEvent?.({ type: "turn_start" });

    let result;
    try {
      result = await provider.runTurn({
        model,
        systemPrompt: currentSystemPrompt,
        tools,
        messages,
        maxTokens,
        thinking,
        compaction,
        signal: toolCtx.signal,
        handlers: {
          onTextDelta: (text) => onEvent?.({ type: "text_delta", text }),
          onThinkingDelta: (text) =>
            onEvent?.({ type: "thinking_delta", text }),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onEvent?.({ type: "error", message });
      throw err;
    }

    cacheReadTokens += result.usage.cacheReadTokens;
    cacheWriteTokens += result.usage.cacheWriteTokens;
    inputTokens += result.usage.inputTokens;
    outputTokens += result.usage.outputTokens;
    stopReason = result.stopReason;

    const assistant: StoredMessage = {
      role: "assistant",
      content: result.content,
    };
    messages.push(assistant);
    await onMessagePersist?.(assistant);

    const lastText =
      (result.content.find((b) => b.type === "text") as Anthropic.TextBlock | undefined)
        ?.text ?? "";
    if (lastText) finalText = lastText;

    if (result.stopReason !== "tool_use") {
      onEvent?.({ type: "turn_end" });
      break;
    }

    const toolUses = result.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const call of toolUses) {
      onEvent?.({
        type: "tool_call_start",
        toolName: call.name,
        toolInput: call.input,
      });
      const tool = toolMap.get(call.name);
      if (!tool) {
        const errMsg = `tool "${call.name}" is not registered`;
        toolResults.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: errMsg,
          is_error: true,
        });
        onEvent?.({
          type: "tool_call_end",
          toolName: call.name,
          isError: true,
          toolResult: "unregistered",
        });
        continue;
      }

      if (opts.approval) {
        const decision = await opts.approval(call.name, call.input);
        if (!decision.allow) {
          const reason = decision.reason ?? "user denied";
          toolResults.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: `[denied] ${reason}`,
            is_error: true,
          });
          onEvent?.({
            type: "tool_call_end",
            toolName: call.name,
            isError: true,
            toolResult: reason,
          });
          continue;
        }
      }

      if (opts.preToolHook) {
        const hook = await opts.preToolHook(call.name, call.input);
        if (hook?.block) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: `[hook blocked] ${hook.block}`,
            is_error: true,
          });
          onEvent?.({
            type: "tool_call_end",
            toolName: call.name,
            isError: true,
            toolResult: hook.block,
          });
          continue;
        }
      }

      try {
        const raw = await tool.execute(call.input as never, toolCtx);
        let text =
          tool.renderResultForModel?.(raw) ??
          (typeof raw === "string" ? raw : JSON.stringify(raw));
        if (opts.postToolHook) {
          const hook = await opts.postToolHook(call.name, call.input, text, false);
          if (hook?.rewriteResult != null) text = hook.rewriteResult;
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: text,
        });
        onEvent?.({
          type: "tool_call_end",
          toolName: call.name,
          toolResult: text.slice(0, 240),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        let content = message;
        if (opts.postToolHook) {
          const hook = await opts.postToolHook(call.name, call.input, message, true);
          if (hook?.rewriteResult != null) content = hook.rewriteResult;
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: call.id,
          content,
          is_error: true,
        });
        onEvent?.({
          type: "tool_call_end",
          toolName: call.name,
          isError: true,
          toolResult: content,
        });
      }
    }
    const toolMessage: StoredMessage = { role: "user", content: toolResults };
    messages.push(toolMessage);
    await onMessagePersist?.(toolMessage);
    onEvent?.({ type: "turn_end" });
  }

  return {
    finalText,
    history: messages,
    iterations,
    cacheReadTokens,
    cacheWriteTokens,
    inputTokens,
    outputTokens,
    stopReason,
  };
}

export function extractTextFromContent(content: StoredMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
