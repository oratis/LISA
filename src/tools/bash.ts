import { capsOf } from "../capabilities/index.js";
import type { ToolDefinition } from "../types.js";

interface BashInput {
  command: string;
  timeout_ms?: number;
}

const DEFAULT_TIMEOUT = 60_000;
const MAX_TIMEOUT = 600_000;
const MAX_OUTPUT = 64 * 1024;

export const bashTool: ToolDefinition<BashInput, string> = {
  name: "bash",
  description:
    "Run a shell command via /bin/bash and return its stdout, stderr, and exit code. " +
    "Use this for git operations, package managers, build scripts, file inspection (head/tail/wc), and one-off scripts. " +
    "Under a bounded sandbox mode the command is confined by the OS (macOS Seatbelt / Linux bubblewrap) " +
    "to the same roots the file tools are; on a platform where that cannot be enforced the command is refused. " +
    "Long outputs are truncated to 64KB. Default timeout is 60s; max 600s.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout_ms: { type: "integer", minimum: 1000, maximum: MAX_TIMEOUT },
    },
    required: ["command"],
  },
  async execute(input, ctx) {
    const { shell } = capsOf(ctx);
    const result = await shell.run(input.command, {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeoutMs: Math.min(input.timeout_ms ?? DEFAULT_TIMEOUT, MAX_TIMEOUT),
      maxOutputBytes: MAX_OUTPUT,
    });
    const parts = [
      `exit_code=${result.code ?? "null"}${result.signal ? ` signal=${result.signal}` : ""}`,
    ];
    if (result.stdout) parts.push(`--- stdout ---\n${result.stdout}`);
    if (result.stderr) parts.push(`--- stderr ---\n${result.stderr}`);
    if (result.truncated) parts.push("[output truncated at 64KB]");
    return parts.join("\n");
  },
};
