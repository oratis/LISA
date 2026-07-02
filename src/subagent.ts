import { runAgent } from "./agent.js";
import { DEFAULT_MODEL } from "./llm.js";
import { providerForModel } from "./providers/registry.js";
import type { Provider } from "./providers/types.js";
import type { ToolDefinition } from "./types.js";

export interface SubagentOptions {
  prompt: string;
  systemPrompt: string;
  tools: ToolDefinition[];
  cwd: string;
  signal: AbortSignal;
  model?: string;
  log?: (msg: string) => void;
  thinking?: boolean;
  /** Thinking-depth lever; defaults to "low" — subagents are cheap parallel work. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Cumulative (input+output) token ceiling; stops the run early when reached. */
  budgetTokens?: number;
  /** Injectable provider (tests); defaults to providerForModel(model). */
  provider?: Provider;
}

export interface SubagentResult {
  text: string;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  /** "end_turn" | "max_iterations" | "budget_exceeded" | … — lets callers see truncation. */
  stopReason: string;
}

export async function runSubagent(opts: SubagentOptions): Promise<SubagentResult> {
  const model = opts.model ?? DEFAULT_MODEL;
  const provider = opts.provider ?? providerForModel(model);
  let toolCallCount = 0;
  const result = await runAgent({
    provider,
    systemPrompt: opts.systemPrompt,
    tools: opts.tools,
    toolCtx: {
      cwd: opts.cwd,
      signal: opts.signal,
      log: opts.log ?? (() => {}),
    },
    history: [],
    userMessage: opts.prompt,
    model,
    thinking: opts.thinking ?? false,
    effort: opts.effort ?? "low",
    onEvent: (event) => {
      if (event.type === "tool_call_start") toolCallCount++;
    },
    maxIterations: 32,
    budgetTokens: opts.budgetTokens,
  });
  return {
    text: result.finalText,
    toolCallCount,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    stopReason: result.stopReason,
  };
}
