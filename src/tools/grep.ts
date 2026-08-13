import { capsOf } from "../capabilities/index.js";
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
    const { fs, shell } = capsOf(ctx);
    const target = fs.resolvePath(ctx.cwd, input.path ?? ".");
    const max = input.max_results ?? DEFAULT_MAX;
    const args = ["-RnE", "--exclude-dir=node_modules", "--exclude-dir=.git"];
    if (input.ignore_case) args.push("-i");
    if (input.glob) args.push(`--include=${input.glob}`);
    // `exec`, not `run`: the pattern is model-supplied, and putting it through
    // a shell string is how a search turns into command execution.
    args.push("-e", input.pattern, target);
    const result = await shell.exec("grep", args, {
      cwd: ctx.cwd,
      signal: ctx.signal,
      maxOutputBytes: 256 * 1024,
    });
    // grep's exit codes: 0 = matches, 1 = none, >1 = real error.
    if (result.code === 1) return "(no matches)";
    if (result.code !== 0 && result.code !== null) {
      throw new Error(`grep exited ${result.code}: ${result.stderr.trim()}`);
    }
    const lines = result.stdout.split("\n").filter(Boolean);
    const trimmed = lines.slice(0, max).join("\n");
    const more =
      lines.length > max ? `\n[... ${lines.length - max} more matches ...]` : "";
    return trimmed + more;
  },
};
