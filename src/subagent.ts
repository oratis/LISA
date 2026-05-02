import { runAgent } from "./agent.js";
import { DEFAULT_MODEL } from "./llm.js";
import { providerForModel } from "./providers/registry.js";
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
}

export interface SubagentResult {
  text: string;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
}

export async function runSubagent(opts: SubagentOptions): Promise<SubagentResult> {
  const model = opts.model ?? DEFAULT_MODEL;
  const provider = providerForModel(model);
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
    onEvent: (event) => {
      if (event.type === "tool_call_start") toolCallCount++;
    },
    maxIterations: 32,
  });
  return {
    text: result.finalText,
    toolCallCount,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}
