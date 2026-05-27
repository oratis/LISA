import type { ToolDefinition } from "../types.js";
import { runSubagent } from "../subagent.js";

interface TaskInput {
  description: string;
  prompt: string;
  type?: "explore" | "general";
  model?: string;
}

const EXPLORE_SYSTEM = `You are a focused exploration sub-agent spawned by Lisa to handle a single research task.
Use \`read\`, \`grep\`, \`ls\`, and \`bash\` (read-only commands) to investigate.
Do NOT write files, edit files, or run destructive commands.
Return a concise final report (under 400 words) summarizing findings with concrete paths and line numbers.`;

const GENERAL_SYSTEM = `You are a focused sub-agent spawned by Lisa to complete one well-scoped task.
You have the full Lisa toolset available. Be efficient: do the task, then report what you did.
Return a concise final summary.`;

export function createTaskTool(deps: {
  fullToolset: () => ToolDefinition[];
  readOnlyToolset: () => ToolDefinition[];
  cwd: string;
  signal: AbortSignal;
  defaultModel: string;
}): ToolDefinition<TaskInput, string> {
  return {
    name: "task",
    description:
      "Spawn a sub-agent to handle a self-contained task in its own context window. " +
      "Use this for: exploring large codebases (`type: explore`), running multi-step research, " +
      "or fanning out independent work in parallel. The sub-agent has the full toolset by default; " +
      "with `type: explore` it gets only read-only tools (read/grep/ls/bash).\n" +
      "Return value: the sub-agent's final summary text.",
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "3-5 word label for the task (shown in the UI)",
        },
        prompt: {
          type: "string",
          description: "Self-contained instructions. The sub-agent has no memory of this conversation.",
        },
        type: {
          type: "string",
          enum: ["explore", "general"],
          default: "general",
        },
        model: {
          type: "string",
          description: "Optional model override (e.g. claude-haiku-4-5 for speed)",
        },
      },
      required: ["description", "prompt"],
    },
    async execute(input) {
      const tools =
        input.type === "explore" ? deps.readOnlyToolset() : deps.fullToolset();
      const system =
        input.type === "explore" ? EXPLORE_SYSTEM : GENERAL_SYSTEM;
      const result = await runSubagent({
        prompt: input.prompt,
        systemPrompt: system,
        tools,
        cwd: deps.cwd,
        signal: deps.signal,
        model: input.model ?? deps.defaultModel,
      });
      return `[subagent: ${input.description} — ${result.toolCallCount} tool calls, ${result.outputTokens} tokens]\n${result.text}`;
    },
  };
}
