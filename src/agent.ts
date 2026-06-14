import type Anthropic from "@anthropic-ai/sdk";
import type {
  AgentEvent,
  StoredMessage,
  ToolContext,
  ToolDefinition,
} from "./types.js";
import type { Provider } from "./providers/types.js";
import { moodBus } from "./mood-bus.js";
import { validateToolInput } from "./tools/validate.js";

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
  toolCtx: ToolContext;
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
  /**
   * Optional cumulative (input+output) token ceiling for the whole run. Checked
   * at each turn boundary; once exceeded the loop stops before the next provider
   * call with stopReason "budget_exceeded". Used by self-driven runs (idle /
   * heartbeat) as a cost circuit-breaker so a runaway tool loop can't burn
   * unbounded tokens unattended. Unset = no ceiling.
   */
  budgetTokens?: number;
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
  /**
   * The provider's stop reason from the final turn ("end_turn", "max_tokens",
   * …), or "max_iterations" when the loop hit `maxIterations` while the model
   * still wanted to call tools, or "budget_exceeded" when `budgetTokens` was
   * reached (both mean the run was truncated, not finished).
   */
  stopReason: string;
}

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  // Surface "thinking" state to any subscriber (web GUI, island widget, etc).
  // try/finally guarantees chat_end fires even on throw / cancel.
  moodBus.chatStart();
  try {
    return await runAgentLoop(opts);
  } finally {
    moodBus.chatEnd();
  }
}

async function runAgentLoop(opts: RunAgentOptions): Promise<RunAgentResult> {
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
    budgetTokens,
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

  // ── soul_object enforcement (Phase 2.1) ─────────────────────────────
  // Lisa's soul_object tool registers a constitutional objection here. When
  // the LLM finishes a turn (stopReason !== tool_use) with un-surfaced
  // objections, the loop forces ONE more iteration that explicitly asks her
  // to address them in her reply. Cap at one forced re-prompt so a stubborn
  // model can't get stuck in a loop; if she still ignores after the force,
  // we let it go and rely on weekly_examen / git history for accountability.
  type PendingObjection = { reason: string; refusing: boolean; userRequestSummary: string };
  const pendingObjections: PendingObjection[] = [];
  let objectionForceUsed = false;
  toolCtx.onObjection = (o) => {
    pendingObjections.push(o);
  };

  while (iterations < maxIterations) {
    // Token budget circuit-breaker (cost guard for unattended self-driven runs).
    // Checked at the turn boundary — before the next provider call — so we never
    // pre-empt mid-turn and leave a tool_use without its tool_result. The prior
    // turn's tools have already run and their results are in history, so this is
    // a clean stop point.
    if (budgetTokens && iterations > 0 && inputTokens + outputTokens >= budgetTokens) {
      stopReason = "budget_exceeded";
      onEvent?.({
        type: "info",
        message: `[agent] token budget ${budgetTokens} reached after ${iterations} iteration(s) — stopping (stopReason=budget_exceeded)`,
      });
      break;
    }
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

    // OpenAI/Gemini turns can yield neither text nor tool calls, i.e. an
    // empty content array. Anthropic's API rejects assistant messages with
    // empty content (400), so keep them out of history/persistence entirely.
    // Safe to skip: an empty message carries no tool_use blocks, so no
    // tool_result pairing depends on it.
    if (result.content.length > 0) {
      const assistant: StoredMessage = {
        role: "assistant",
        content: result.content,
      };
      messages.push(assistant);
      await onMessagePersist?.(assistant);
    }

    const lastText =
      (result.content.find((b) => b.type === "text") as Anthropic.TextBlock | undefined)
        ?.text ?? "";
    if (lastText) finalText = lastText;

    if (result.stopReason !== "tool_use") {
      // Before closing the turn, check whether soul_object fired during this
      // turn but Lisa never surfaced it. If so, force one corrective turn.
      if (pendingObjections.length > 0 && !objectionForceUsed) {
        const list = pendingObjections
          .map(
            (o) =>
              `- ${o.reason}${o.refusing ? " [refusing]" : " [will comply, surfacing]"} — re: "${o.userRequestSummary}"`,
          )
          .join("\n");
        const forced: StoredMessage = {
          role: "user",
          content: [
            {
              type: "text",
              text:
                `[architecture] You raised the following objection(s) during this turn but did not address them in your reply. ` +
                `The architecture requires you to surface them now — explain to the user what you objected to and how you'll proceed (comply / refuse / comply-with-caveat). Do this in your own voice. The objections:\n\n${list}`,
            },
          ],
        };
        messages.push(forced);
        await onMessagePersist?.(forced);
        currentSystemPrompt =
          currentSystemPrompt +
          `\n\n## Pending objections you must surface\n${list}\nYou MUST address each item above explicitly in your next reply.`;
        objectionForceUsed = true;
        onEvent?.({
          type: "info",
          message: `[soul_object] forcing objection-surfacing turn (${pendingObjections.length} pending)`,
        });
        // Drain so we don't re-trigger.
        pendingObjections.length = 0;
        // Don't end the turn — loop again so the LLM addresses the objections.
        onEvent?.({ type: "turn_end" });
        continue;
      }
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

      // FOUNDATIONS §2.3 — validate the model's input against the tool's schema
      // before running it. Malformed input never reaches execute(); the model
      // gets a friendly error to correct on the next turn.
      const valid = validateToolInput(tool.inputSchema, call.input);
      if (!valid.ok) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: `[invalid input] ${valid.error}`,
          is_error: true,
        });
        onEvent?.({
          type: "tool_call_end",
          toolName: call.name,
          isError: true,
          toolResult: valid.error ?? "invalid input",
        });
        continue;
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

  // The loop breaks whenever a turn ends with stopReason !== "tool_use", so
  // landing here with "tool_use" means the iteration cap truncated a run the
  // model wanted to continue. Make that visible to callers and the UI instead
  // of silently reporting the last provider stop reason.
  if (iterations >= maxIterations && stopReason === "tool_use") {
    stopReason = "max_iterations";
    onEvent?.({
      type: "info",
      message: `[agent] stopped after ${maxIterations} iterations with tool calls still pending (stopReason=max_iterations)`,
    });
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
