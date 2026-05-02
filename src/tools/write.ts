import path from "node:path";
import { atomicWrite } from "../fs-utils.js";
import type { ToolDefinition } from "../types.js";

interface WriteInput {
  path: string;
  content: string;
}

export const writeTool: ToolDefinition<WriteInput, string> = {
  name: "write",
  description:
    "Write a text file to the local filesystem, creating parent directories as needed. " +
    "Overwrites if the file already exists. Use `edit` to make targeted changes to existing files instead of rewriting them wholesale.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  async execute(input, ctx) {
    const abs = path.resolve(ctx.cwd, input.path);
    await atomicWrite(abs, input.content);
    return `Wrote ${input.content.length} chars to ${abs}`;
  },
};
