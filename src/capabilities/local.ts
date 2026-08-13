/**
 * Local provider — the host's own filesystem and shell.
 *
 * This is the behaviour every fs/shell tool had inline before H1, moved behind
 * the seam verbatim. It intentionally imposes no boundary of its own: bounding
 * the world is H2's sandboxed provider, and conflating "how do I reach the
 * disk" with "what am I allowed to reach" is what made the old code impossible
 * to bound in one place.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { atomicWrite } from "../fs-utils.js";
import { defaultSandboxSpec, wrapForSandbox } from "../sandbox/sandbox.js";
import type {
  Capabilities,
  ExecOptions,
  ExecResult,
  FsCapability,
  FsDirEntry,
  FsStat,
  ShellCapability,
} from "./types.js";

export const localFs: FsCapability = {
  resolvePath(cwd: string, p: string): string {
    return path.resolve(cwd, p);
  },
  async stat(abs: string): Promise<FsStat> {
    const s = await fs.stat(abs);
    return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size };
  },
  async exists(abs: string): Promise<boolean> {
    try {
      await fs.access(abs);
      return true;
    } catch {
      return false;
    }
  },
  async readFile(abs: string): Promise<string> {
    return await fs.readFile(abs, "utf8");
  },
  async writeFile(abs: string, content: string): Promise<void> {
    await atomicWrite(abs, content);
  },
  async readdir(abs: string): Promise<FsDirEntry[]> {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      isFile: e.isFile(),
      isDirectory: e.isDirectory(),
    }));
  },
  async unlink(abs: string): Promise<void> {
    await fs.unlink(abs);
  },
};

/**
 * Shared child-process driver for both shell operations. Collects bounded
 * output, enforces a timeout with SIGTERM→SIGKILL escalation, and resolves
 * (rather than rejects) on a non-zero exit — a failing command is a result the
 * model should see, not an exception.
 */
function runChild(
  file: string,
  args: string[],
  opts: ExecOptions,
): Promise<ExecResult> {
  const maxOutput = opts.maxOutputBytes ?? 64 * 1024;
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: process.env,
      signal: opts.signal,
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const onData = (buf: Buffer, target: "stdout" | "stderr") => {
      const text = buf.toString("utf8");
      if (target === "stdout") {
        if (stdout.length + text.length > maxOutput) {
          stdout += text.slice(0, maxOutput - stdout.length);
          truncated = true;
        } else {
          stdout += text;
        }
      } else {
        if (stderr.length + text.length > maxOutput) {
          stderr += text.slice(0, maxOutput - stderr.length);
          truncated = true;
        } else {
          stderr += text;
        }
      }
    };
    child.stdout.on("data", (b: Buffer) => onData(b, "stdout"));
    child.stderr.on("data", (b: Buffer) => onData(b, "stderr"));

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 2000);
        }, opts.timeoutMs)
      : undefined;

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code, signal, truncated });
    });
  });
}

export const localShell: ShellCapability = {
  async run(command: string, opts: ExecOptions): Promise<ExecResult> {
    // The opt-in LISA_SANDBOX wrapper moved here from the bash tool: which
    // confinement a command runs under is a property of the execution world,
    // not of the tool that asked. H2 replaces this with a real sandboxed
    // provider (and closes the hole that fs writes never went through it);
    // for now it is the previous behaviour, relocated unchanged.
    const wrapped = await wrapForSandbox(
      defaultSandboxSpec({ cwd: opts.cwd }),
      command,
    );
    try {
      return await runChild(wrapped.command, wrapped.args, opts);
    } finally {
      await wrapped.cleanup?.();
    }
  },
  async exec(file: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
    return await runChild(file, args, opts);
  },
};

export const LOCAL_CAPABILITIES: Capabilities = {
  fs: localFs,
  shell: localShell,
};
