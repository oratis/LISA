import fs from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "../fs-utils.js";
import type { ToolDefinition } from "../types.js";

interface EditInput {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export const editTool: ToolDefinition<EditInput, string> = {
  name: "edit",
  description:
    "Replace exact text in an existing file. `old_string` must match the file content verbatim (whitespace included). " +
    "By default it must match exactly once; pass `replace_all: true` to replace every occurrence (useful for renames). " +
    "Use `read` first to see the exact text to match.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean", default: false },
    },
    required: ["path", "old_string", "new_string"],
  },
  async execute(input, ctx) {
    if (input.old_string === input.new_string) {
      throw new Error("old_string and new_string are identical");
    }
    const abs = path.resolve(ctx.cwd, input.path);
    const original = await fs.readFile(abs, "utf8");
    const occurrences = countOccurrences(original, input.old_string);
    if (occurrences === 0) {
      throw new Error(`old_string not found in ${abs}`);
    }
    if (occurrences > 1 && !input.replace_all) {
      throw new Error(
        `old_string matches ${occurrences} places. Pass replace_all:true or add more context to match exactly once.`,
      );
    }
    const updated = input.replace_all
      ? original.split(input.old_string).join(input.new_string)
      : original.replace(input.old_string, input.new_string);
    await atomicWrite(abs, updated);
    return `Edited ${abs}: ${input.replace_all ? occurrences : 1} replacement(s).`;
  },
};

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}
