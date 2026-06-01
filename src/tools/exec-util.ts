/**
 * Small process-exec helper shared by the repo/PR/check tools. Runs a command
 * in a given directory, captures (capped) output, honours an AbortSignal and a
 * timeout. Never throws — returns a result with the exit code so callers branch
 * on it. Dependency-free (node:child_process only).
 */
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when the binary itself couldn't be spawned (e.g. not installed). */
  spawnError?: string;
}

export function runIn(
  cwd: string,
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; signal?: AbortSignal; maxBytes?: number } = {},
): Promise<ExecResult> {
  const cap = opts.maxBytes ?? 64 * 1024;
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { cwd, signal: opts.signal });
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, spawnError: String((e as Error).message) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try {
            child.kill("SIGKILL");
          } catch {}
        }, opts.timeoutMs)
      : null;
    child.stdout?.on("data", (b: Buffer) => {
      if (stdout.length < cap) stdout += b.toString("utf8");
    });
    child.stderr?.on("data", (b: Buffer) => {
      if (stderr.length < cap) stderr += b.toString("utf8");
    });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut, spawnError: String((e as Error).message) });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** Validate that `p` is an absolute path to an existing directory. */
export async function isDir(p: string): Promise<boolean> {
  if (!p || !p.startsWith("/")) return false;
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** `git -C <cwd> rev-parse --show-toplevel` → repo root, or null if not a repo. */
export async function gitRoot(cwd: string, signal?: AbortSignal): Promise<string | null> {
  const r = await runIn(cwd, "git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeoutMs: 5000, signal });
  if (r.code === 0) {
    const root = r.stdout.trim();
    return root || null;
  }
  return null;
}
