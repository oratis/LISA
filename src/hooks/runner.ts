import { spawn } from "node:child_process";
import type { HookSpec } from "../plugins/types.js";

export interface HookEnv {
  TOOL_NAME?: string;
  TOOL_INPUT?: string;
  TOOL_RESULT?: string;
  TOOL_ERROR?: string;
  USER_PROMPT?: string;
  SESSION_ID?: string;
  CLAUDE_PROJECT_DIR?: string;
  LISA_HOME?: string;
}

export interface HookOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runHook(
  hook: HookSpec,
  env: HookEnv,
  cwd: string,
): Promise<HookOutput> {
  return await new Promise<HookOutput>((resolve, reject) => {
    const child = spawn("/bin/bash", ["-lc", hook.command], {
      cwd,
      env: { ...process.env, ...env } as Record<string, string>,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    const timer = setTimeout(
      () => child.kill("SIGTERM"),
      hook.timeout_ms ?? 10_000,
    );
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });
}

export interface HookFireResult {
  blocked: string[];
  rewriteResult?: string;
}

export async function fireHooks(
  event: HookSpec["event"],
  hooks: HookSpec[],
  env: HookEnv,
  cwd: string,
): Promise<HookFireResult> {
  const matched = hooks.filter((h) => {
    if (h.event !== event) return false;
    if (!h.matcher) return true;
    const target = env.TOOL_NAME ?? "";
    try {
      return new RegExp(h.matcher).test(target);
    } catch {
      return target === h.matcher;
    }
  });
  const blocked: string[] = [];
  let rewrite: string | undefined;
  for (const hook of matched) {
    try {
      const output = await runHook(hook, env, cwd);
      if (output.exitCode === 2 && (event === "PreToolUse" || event === "UserPromptSubmit")) {
        blocked.push(output.stderr.trim() || `hook blocked (${hook.command})`);
      } else if (output.exitCode === 2 && event === "PostToolUse") {
        rewrite = output.stdout;
      }
    } catch (err) {
      blocked.push(`hook error: ${(err as Error).message}`);
    }
  }
  return { blocked, rewriteResult: rewrite };
}
