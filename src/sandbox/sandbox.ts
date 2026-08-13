import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { buildMacosSeatbeltPolicy } from "./macos.js";
import {
  SandboxUnavailableError,
  modeIsBounded,
  resolveSandboxMode,
  type SandboxMode,
} from "./mode.js";

export interface SandboxSpec {
  mode: SandboxMode;
  allowNetwork: boolean;
  cwd: string;
}

export interface SandboxedCommand {
  command: string;
  args: string[];
  cleanup?: () => Promise<void>;
}

/**
 * Wrap a shell command in whatever confinement the host can actually enforce
 * for `spec.mode`.
 *
 * The one hard rule: when the mode asks for confinement and no mechanism is
 * available, this THROWS `SANDBOX_UNAVAILABLE`. It used to return a plain
 * `/bin/bash -lc` on Linux, which meant a user who set LISA_SANDBOX=1 on Linux
 * got no sandbox and no indication — the failure mode where you act on a
 * guarantee you do not have.
 */
export async function wrapForSandbox(
  spec: SandboxSpec,
  shellCommand: string,
): Promise<SandboxedCommand> {
  if (!modeIsBounded(spec.mode)) {
    return { command: "/bin/bash", args: ["-lc", shellCommand] };
  }

  if (process.platform === "darwin") {
    const policy = buildMacosSeatbeltPolicy({
      cwd: spec.cwd,
      allowNetwork: spec.allowNetwork,
      mode: spec.mode,
    });
    const tmp = path.join(
      os.tmpdir(),
      `lisa-seatbelt-${crypto.randomBytes(4).toString("hex")}.sb`,
    );
    await fs.writeFile(tmp, policy, "utf8");
    return {
      command: "/usr/bin/sandbox-exec",
      args: ["-f", tmp, "/bin/bash", "-lc", shellCommand],
      cleanup: async () => {
        try {
          await fs.unlink(tmp);
        } catch {}
      },
    };
  }

  if (process.platform === "linux" && hasBubblewrap()) {
    return { command: "bwrap", args: [...bwrapArgs(spec), "/bin/bash", "-lc", shellCommand] };
  }

  throw new SandboxUnavailableError(
    `sandbox mode "${spec.mode}" cannot be enforced on ${process.platform}: ` +
      (process.platform === "linux"
        ? "bubblewrap (bwrap) is not installed. Install it (apt install bubblewrap), "
        : "no supported confinement mechanism, ") +
      `or set LISA_SANDBOX_MODE=danger-full-access to run unconfined on purpose. ` +
      `Refusing to run the command unconfined while a sandbox was requested.`,
);
}

/**
 * bubblewrap invocation for a bounded mode: a read-only bind of the whole
 * filesystem, then the writable paths the mode grants layered on top.
 *
 * Untested on this project's CI (macOS host); the fail-closed path above is
 * what protects a Linux user if this is wrong — a bad invocation makes bwrap
 * exit non-zero, which surfaces, rather than silently running unconfined.
 */
function bwrapArgs(spec: SandboxSpec): string[] {
  const args = [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--die-with-parent",
  ];
  if (spec.mode === "workspace-write") {
    args.push("--bind", spec.cwd, spec.cwd);
    args.push("--bind", os.tmpdir(), os.tmpdir());
  }
  if (!spec.allowNetwork) args.push("--unshare-net");
  args.push("--chdir", spec.cwd);
  return args;
}

let bubblewrapChecked: boolean | undefined;
function hasBubblewrap(): boolean {
  if (bubblewrapChecked !== undefined) return bubblewrapChecked;
  try {
    const probe = spawnSync("bwrap", ["--version"], { stdio: "ignore" });
    bubblewrapChecked = probe.status === 0;
  } catch {
    bubblewrapChecked = false;
  }
  return bubblewrapChecked;
}

/** Test hook — the bwrap probe is cached for the process lifetime. */
export function _resetBubblewrapProbeForTest(): void {
  bubblewrapChecked = undefined;
}

export function defaultSandboxSpec(opts: {
  cwd: string;
  mode?: SandboxMode;
}): SandboxSpec {
  return {
    mode: resolveSandboxMode(opts.mode),
    allowNetwork: process.env.LISA_SANDBOX_NETWORK !== "0",
    cwd: opts.cwd,
  };
}
