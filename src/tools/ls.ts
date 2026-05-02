import fs from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../types.js";

interface LsInput {
  path?: string;
}

export const lsTool: ToolDefinition<LsInput, string> = {
  name: "ls",
  description:
    "List the immediate contents of a directory with type and size. " +
    "`path` defaults to the current working directory. Hidden entries are skipped.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
    },
  },
  async execute(input, ctx) {
    const target = path.resolve(ctx.cwd, input.path ?? ".");
    const entries = await fs.readdir(target, { withFileTypes: true });
    const rows: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = path.join(target, entry.name);
      if (entry.isDirectory()) {
        rows.push(`d  -          ${entry.name}/`);
      } else if (entry.isFile()) {
        const stat = await fs.stat(abs);
        rows.push(`f  ${String(stat.size).padStart(9, " ")}  ${entry.name}`);
      } else {
        rows.push(`?  -          ${entry.name}`);
      }
    }
    rows.sort();
    return `${target}\n${rows.join("\n") || "(empty)"}`;
  },
};
