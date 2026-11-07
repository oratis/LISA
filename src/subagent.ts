import { runAgent } from "./agent.js";
import { DEFAULT_MODEL } from "./llm.js";
import { providerForModel } from "./providers/registry.js";
import type { Provider } from "./providers/types.js";
import type { ToolContext, ToolDefinition } from "./types.js";

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
  /** Estimated USD ceiling for the run, micro-USD — see RunAgentOptions.costCapMicroUSD. */
  costCapMicroUSD?: number;
  /** Hears every amount counted against the cap — see RunAgentOptions.onCostCharged. */
  onCostCharged?: (microUSD: number) => void;
  /** Injectable provider (tests); defaults to providerForModel(model). */
  provider?: Provider;
  /**
   * How a set_mood inside this run is attributed in Lisa's next system prompt.
   * Every subagent is by definition off to the side of the conversation, so the
   * default says so; idle / heartbeat pass something more specific.
   */
  moodOrigin?: string;
  /**
   * Sandbox mode for this subagent's tools (H2). Unset ⇒ the environment
   * default. Pass the parent turn's mode so a subagent cannot escape the
   * confinement its caller runs under; unattended/untrusted callers (channels,
   * idle, heartbeat, feed/mail classification) may pin a bounded mode.
   */
  sandboxMode?: import("./sandbox/mode.js").SandboxMode;
  /**
   * The parent turn's approval gate. When set, every tool call the subagent
   * makes is decided by it (and it is handed further down to nested runs).
   */
  approval?: ToolContext["approval"];
  /**
   * The parent turn's execution world (ToolContext `caps`): a task run's
   * folder-only filesystem and sandbox. Unset ⇒ the host's own (H1).
   */
  caps?: ToolContext["caps"];
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
      sandboxMode: opts.sandboxMode,
      approval: opts.approval,
      ...(opts.caps ? { caps: opts.caps } : {}),
    },
    approval: opts.approval,
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
    // `undefined` means "no cap"; any other value — including a bad one —
    // reaches the breaker, which fails closed.
    costCapMicroUSD: opts.costCapMicroUSD,
    onCostCharged: opts.onCostCharged,
    moodOrigin: opts.moodOrigin ?? "a background agent",
  });
  return {
    text: result.finalText,
    toolCallCount,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    stopReason: result.stopReason,
  };
}
