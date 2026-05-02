import { spawn } from "node:child_process";
import {
  defaultSandboxSpec,
  wrapForSandbox,
} from "../sandbox/sandbox.js";
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
    "When LISA_SANDBOX=1 the command runs under macOS sandbox-exec restricting writes to cwd + /tmp. " +
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
    const timeout = Math.min(input.timeout_ms ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);
    const wrapped = await wrapForSandbox(
      defaultSandboxSpec({ cwd: ctx.cwd }),
      input.command,
    );
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(wrapped.command, wrapped.args, {
        cwd: ctx.cwd,
        env: process.env,
        signal: ctx.signal,
      });
      let stdout = "";
      let stderr = "";
      let truncated = false;
      const onData = (buf: Buffer, target: "stdout" | "stderr") => {
        const text = buf.toString("utf8");
        if (target === "stdout") {
          if (stdout.length + text.length > MAX_OUTPUT) {
            stdout += text.slice(0, MAX_OUTPUT - stdout.length);
            truncated = true;
          } else {
            stdout += text;
          }
        } else {
          if (stderr.length + text.length > MAX_OUTPUT) {
            stderr += text.slice(0, MAX_OUTPUT - stderr.length);
            truncated = true;
          } else {
            stderr += text;
          }
        }
      };
      child.stdout.on("data", (b) => onData(b, "stdout"));
      child.stderr.on("data", (b) => onData(b, "stderr"));
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000);
      }, timeout);
      child.on("error", async (err) => {
        clearTimeout(timer);
        await wrapped.cleanup?.();
        reject(err);
      });
      child.on("close", async (code, signal) => {
        clearTimeout(timer);
        await wrapped.cleanup?.();
        const parts = [
          `exit_code=${code ?? "null"}${signal ? ` signal=${signal}` : ""}`,
        ];
        if (stdout) parts.push(`--- stdout ---\n${stdout}`);
        if (stderr) parts.push(`--- stderr ---\n${stderr}`);
        if (truncated) parts.push("[output truncated at 64KB]");
        resolve(parts.join("\n"));
      });
    });
  },
};
