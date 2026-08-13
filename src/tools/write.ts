import { capsOf } from "../capabilities/index.js";
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
    const { fs } = capsOf(ctx);
    const abs = fs.resolvePath(ctx.cwd, input.path);
    await fs.writeFile(abs, input.content);
    return `Wrote ${input.content.length} chars to ${abs}`;
  },
};
