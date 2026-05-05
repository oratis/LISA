import { spawn } from "node:child_process";
import type { ToolDefinition } from "../types.js";

interface RedeployInput {
  message?: string;
  build?: boolean;
}

/** Exit code the supervisor watches for to know "rebuild & restart". */
export const REDEPLOY_EXIT_CODE = 75;

export const redeployTool: ToolDefinition<RedeployInput, string> = {
  name: "redeploy",
  description:
    "Rebuild Lisa from her current source (`npm run build`) and restart the server. " +
    "Use this AFTER editing your own files in src/ to make the changes live. " +
    "Requires the supervisor wrapper (scripts/lisa-supervise.sh) — without it the server would just exit. " +
    "Conversation history and memory survive: the same web session is auto-resumed after restart, " +
    "and the browser's SSE reconnects on its own (no page reload needed).",
  inputSchema: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "One-line note about what's being deployed (optional).",
      },
      build: {
        type: "boolean",
        description: "Run `npm run build` before restart. Default true.",
      },
    },
  },
  async execute(input, ctx) {
    if (process.env.LISA_SUPERVISED !== "1") {
      throw new Error(
        "redeploy requires the supervisor. Restart Lisa with:\n  ./scripts/lisa-supervise.sh\nor:\n  bash scripts/lisa-supervise.sh\nThen this tool will work.",
      );
    }
    const wantBuild = input.build !== false;
    if (wantBuild) {
      const result = await runBuild(ctx.cwd, ctx.signal);
      if (result.code !== 0) {
        return [
          "BUILD FAILED — staying on current version. Source edits will not take effect until the build is fixed.",
          `exit_code=${result.code}`,
          result.stderr.length > 0 ? `--- stderr (tail) ---\n${tail(result.stderr, 3000)}` : "",
          result.stdout.length > 0 ? `--- stdout (tail) ---\n${tail(result.stdout, 1500)}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      }
    }
    const sessionId = process.env.LISA_SESSION_ID ?? "(unknown)";
    const note = input.message ? `: ${input.message}` : "";
    // Defer the exit so the tool result has a moment to flush back over SSE
    // and the agent loop has a chance to wrap up cleanly.
    setTimeout(() => process.exit(REDEPLOY_EXIT_CODE), 1500);
    return [
      `Redeploy initiated${note}.`,
      wantBuild ? "Build: ok." : "Build: skipped.",
      `Process will exit ${REDEPLOY_EXIT_CODE}; supervisor will relaunch with the rebuilt code.`,
      `Active session ${sessionId} will be auto-resumed; browser SSE will reconnect on its own.`,
    ].join(" ");
  },
};

async function runBuild(
  cwd: string,
  signal: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn("npm", ["run", "build"], {
      cwd,
      env: process.env,
      signal,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    child.on("close", (code) =>
      resolve({ code: code ?? 1, stdout, stderr }),
    );
    child.on("error", (err) =>
      resolve({ code: 1, stdout, stderr: stderr || String(err) }),
    );
  });
}

function tail(s: string, n: number): string {
  return s.length > n ? s.slice(-n) : s;
}
