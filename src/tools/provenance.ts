import { lisaHome } from "../paths.js";
import type { ToolDefinition } from "../types.js";
import { queryProvenance } from "../warden/provenance.js";

export const provenanceTool: ToolDefinition = {
  name: "provenance",
  description:
    "Inspect Warden's redacted audit provenance for writes to persistent self-state " +
    "(memory, soul, knowledge base, skills), including whether a write happened during " +
    "a tainted run and which earlier external reads/fetches tainted that conversation or task.",
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: "object",
    properties: {
      tainted_only: {
        type: "boolean",
        description: "Only return persistent writes made during tainted runs (default false).",
      },
      tool: {
        type: "string",
        description: 'Optional tool filter (e.g. "memory", "kb_write", "soul_patch").',
      },
      origin_id: {
        type: "string",
        description: "Optional conversation or origin id filter.",
      },
      task_id: {
        type: "string",
        description: "Optional task id filter.",
      },
      limit: {
        type: "number",
        description: "Maximum records to return (1-200, default 25).",
      },
    },
  },
  async execute(input) {
    const args = (input ?? {}) as Record<string, unknown>;
    const taintedOnly = args.tainted_only === true;
    const tool = typeof args.tool === "string" && args.tool.trim() ? args.tool.trim() : undefined;
    const originId =
      typeof args.origin_id === "string" && args.origin_id.trim()
        ? args.origin_id.trim()
        : undefined;
    const taskId =
      typeof args.task_id === "string" && args.task_id.trim() ? args.task_id.trim() : undefined;
    const rawLimit = typeof args.limit === "number" ? args.limit : 25;
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(Math.floor(rawLimit), 200)) : 25;

    const report = await queryProvenance({
      home: lisaHome(),
      taintedOnly,
      tool,
      originId,
      taskId,
      limit,
    });

    return JSON.stringify(report, null, 2);
  },
};
