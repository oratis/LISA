/**
 * Shared launchd / process helpers used by both the heartbeat scheduler and
 * the login autostart installer. Kept dependency-free (node built-ins only).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

/** Escape a string for inclusion as XML text/attribute content in a plist. */
export function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]!),
  );
}

/** Run a command, resolving stdout on exit 0 and rejecting otherwise. */
export function runCmd(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(`${cmd} exited ${code}: ${stderr.trim()}`)),
    );
  });
}

/**
 * Best-effort path to the `lisa` binary, used for the human-readable
 * instructions line and the Linux service snippet. May return a "node <path>"
 * form when only the local dist build is available.
 */
export async function resolveLisaBin(): Promise<string> {
  try {
    const out = await runCmd("which", ["lisa"]);
    const trimmed = out.trim();
    if (trimmed) return trimmed;
  } catch {}
  const here = path.resolve(process.cwd(), "dist", "cli.js");
  try {
    await fs.access(here);
    return `node ${here}`;
  } catch {}
  return "lisa";
}

/**
 * Resolve the displayed binary into launchd ProgramArguments slots (one argv
 * element per array entry). A "node <path>" form is split into two slots with
 * an absolute node path so launchd — which has no shell and a minimal PATH —
 * can exec it.
 */
export async function resolveLisaArgv(displayedBin: string): Promise<string[]> {
  if (displayedBin.startsWith("node ")) {
    const nodePath =
      (await runCmd("which", ["node"]).catch(() => "node")).trim() || "node";
    return [nodePath, displayedBin.slice("node ".length)];
  }
  return [displayedBin];
}
