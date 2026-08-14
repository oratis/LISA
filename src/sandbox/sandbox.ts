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
  // The shell form: run the command string through a login shell.
  return wrapProgram(spec, ["/bin/bash", "-lc", shellCommand]);
}

/**
 * The argv form of {@link wrapForSandbox}: confine a `command + args` invocation
 * (no shell) under the same mechanism and the same fail-closed rule. This is
 * what `ShellCapability.exec` uses so a bounded mode governs BOTH shell halves —
 * previously `exec` ran unconfined even in `read-only`/`workspace-write`.
 */
export async function wrapArgvForSandbox(
  spec: SandboxSpec,
  command: string,
  args: string[],
): Promise<SandboxedCommand> {
  return wrapProgram(spec, [command, ...args]);
}

/** Shared core: wrap a full argv (`program[0]` = executable) for `spec.mode`. */
async function wrapProgram(
  spec: SandboxSpec,
  program: string[],
): Promise<SandboxedCommand> {
  if (!modeIsBounded(spec.mode)) {
    return { command: program[0]!, args: program.slice(1) };
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
      args: ["-f", tmp, ...program],
      cleanup: async () => {
        try {
          await fs.unlink(tmp);
        } catch {}
      },
    };
  }

  if (process.platform === "linux" && hasBubblewrap()) {
    return { command: "bwrap", args: [...bwrapArgs(spec), ...program] };
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

/** True when this host has a mechanism that can actually enforce a bounded mode. */
export function sandboxEnforceable(): boolean {
  return (
    process.platform === "darwin" ||
    (process.platform === "linux" && hasBubblewrap())
  );
}

let warnedUnenforceable = false;
/**
 * The mode the unattended / untrusted surfaces (channels, idle, heartbeat,
 * feed/mail classification) default to. These process the least-trusted input
 * — an inbound DM, a fetched web page — so they should not inherit the local
 * user's `danger-full-access`. Where the host can enforce it we cap them at
 * `workspace-write` (honouring a stricter env pin); where it cannot, bounded
 * modes would fail closed and silently break autonomy, so we keep the env
 * default and warn ONCE — a loud "install bwrap" beats a broken heartbeat.
 * An operator can force fail-closed everywhere with `LISA_SANDBOX_MODE`.
 */
export function untrustedSurfaceMode(): SandboxMode {
  const env = resolveSandboxMode();
  if (!sandboxEnforceable()) {
    if (!warnedUnenforceable) {
      warnedUnenforceable = true;
      console.error(
        "[sandbox] untrusted surfaces (channels/idle/heartbeat) run UNCONFINED — no OS " +
          "sandbox on this host; install bubblewrap (Linux) or set LISA_SANDBOX_MODE to confine them.",
      );
    }
    return env;
  }
  // Enforceable: never looser than workspace-write, but honour a stricter pin.
  return env === "read-only" ? "read-only" : "workspace-write";
}

/** Test hook — the one-time unenforceable warning. */
export function _resetUntrustedWarningForTest(): void {
  warnedUnenforceable = false;
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
