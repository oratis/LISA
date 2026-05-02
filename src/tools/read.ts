import fs from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../types.js";

interface ReadInput {
  path: string;
  offset?: number;
  limit?: number;
}

const MAX_BYTES = 256 * 1024;
const DEFAULT_LIMIT = 2000;

export const readTool: ToolDefinition<ReadInput, string> = {
  name: "read",
  description:
    "Read a text file from the local filesystem. Path may be absolute or relative to the current working directory. " +
    "Returns up to `limit` lines starting at `offset` (1-indexed). Default reads first 2000 lines. " +
    "Refuses files larger than 256KB.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      offset: { type: "integer", minimum: 1 },
      limit: { type: "integer", minimum: 1, maximum: 5000 },
    },
    required: ["path"],
  },
  async execute(input, ctx) {
    const abs = path.resolve(ctx.cwd, input.path);
    const stat = await fs.stat(abs);
    if (!stat.isFile()) throw new Error(`not a file: ${abs}`);
    if (stat.size > MAX_BYTES) {
      throw new Error(
        `file too large (${stat.size} bytes, limit ${MAX_BYTES}). Use grep or read with offset/limit.`,
      );
    }
    const raw = await fs.readFile(abs, "utf8");
    const lines = raw.split(/\r?\n/);
    const offset = Math.max(1, input.offset ?? 1);
    const limit = input.limit ?? DEFAULT_LIMIT;
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice
      .map((line, i) => `${String(offset + i).padStart(5, " ")}\t${line}`)
      .join("\n");
    const more = offset - 1 + slice.length < lines.length
      ? `\n[... ${lines.length - (offset - 1 + slice.length)} more lines ...]`
      : "";
    return numbered + more;
  },
};
