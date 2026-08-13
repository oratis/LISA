import type { SandboxMode } from "./mode.js";

/**
 * Seatbelt policy for a given mode.
 *
 * `read-only` grants no writable path at all except the null device: a command
 * that cannot write cannot be given a scratch directory "for convenience"
 * without the mode becoming a lie. `workspace-write` keeps the previous
 * behaviour (cwd + the temp directories a normal toolchain needs).
 */
export function buildMacosSeatbeltPolicy(opts: {
  cwd: string;
  allowNetwork: boolean;
  mode?: SandboxMode;
}): string {
  const mode: SandboxMode = opts.mode ?? "workspace-write";
  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    "; allow basic process operations",
    "(allow process-fork)",
    "(allow process-exec)",
    "(allow signal (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow file-read*)",
    "(allow file-read-metadata)",
    "(allow mach-lookup)",
    "(allow ipc-posix-shm)",
  ];
  if (mode === "workspace-write") {
    lines.push(
      "(allow file-write* (subpath \"/tmp\"))",
      "(allow file-write* (subpath \"/private/tmp\"))",
      "(allow file-write* (subpath \"/var/folders\"))",
      "(allow file-write* (subpath \"/private/var/folders\"))",
      `(allow file-write* (subpath ${jsonString(opts.cwd)}))`,
    );
  } else {
    // read-only: writing to /dev/null is what "no writes" means in practice —
    // countless tools redirect there and would otherwise die on startup.
    lines.push("(allow file-write-data (literal \"/dev/null\"))");
  }
  if (opts.allowNetwork) {
    lines.push("(allow network*)");
  } else {
    lines.push("(allow network* (local ip) (local tcp \"localhost:*\"))");
  }
  return lines.join("\n");
}

function jsonString(s: string): string {
  return JSON.stringify(s);
}
