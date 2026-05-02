import { spawn } from "node:child_process";
import path from "node:path";
import type { ToolDefinition } from "../types.js";

interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  ignore_case?: boolean;
  max_results?: number;
}

const DEFAULT_MAX = 200;

export const grepTool: ToolDefinition<GrepInput, string> = {
  name: "grep",
  description:
    "Recursive regex search via the system `grep` command. Returns matching lines as `path:lineno: text`. " +
    "`pattern` is an extended regex. `path` defaults to the current working directory. " +
    "`glob` filters matched paths (e.g. `*.ts`). Output truncated at `max_results` lines (default 200).",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      glob: { type: "string" },
      ignore_case: { type: "boolean", default: false },
      max_results: { type: "integer", minimum: 1, maximum: 2000 },
    },
    required: ["pattern"],
  },
  async execute(input, ctx) {
    const target = path.resolve(ctx.cwd, input.path ?? ".");
    const max = input.max_results ?? DEFAULT_MAX;
    const args = ["-RnE", "--exclude-dir=node_modules", "--exclude-dir=.git"];
    if (input.ignore_case) args.push("-i");
    if (input.glob) args.push(`--include=${input.glob}`);
    args.push("-e", input.pattern, target);
    return await new Promise<string>((resolve, reject) => {
      const child = spawn("grep", args, { cwd: ctx.cwd, signal: ctx.signal });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (b: Buffer) => {
        if (stdout.length < 256 * 1024) stdout += b.toString("utf8");
      });
      child.stderr.on("data", (b: Buffer) => {
        stderr += b.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 1) return resolve("(no matches)");
        if (code !== 0 && code !== null) {
          return reject(new Error(`grep exited ${code}: ${stderr.trim()}`));
        }
        const lines = stdout.split("\n").filter(Boolean);
        const trimmed = lines.slice(0, max).join("\n");
        const more =
          lines.length > max
            ? `\n[... ${lines.length - max} more matches ...]`
            : "";
        resolve(trimmed + more);
      });
    });
  },
};
