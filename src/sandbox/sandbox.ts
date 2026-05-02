import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { buildMacosSeatbeltPolicy } from "./macos.js";

export interface SandboxSpec {
  enabled: boolean;
  allowNetwork: boolean;
  cwd: string;
}

export interface SandboxedCommand {
  command: string;
  args: string[];
  cleanup?: () => Promise<void>;
}

export async function wrapForSandbox(
  spec: SandboxSpec,
  shellCommand: string,
): Promise<SandboxedCommand> {
  if (!spec.enabled) {
    return { command: "/bin/bash", args: ["-lc", shellCommand] };
  }
  if (process.platform === "darwin") {
    const policy = buildMacosSeatbeltPolicy({
      cwd: spec.cwd,
      allowNetwork: spec.allowNetwork,
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
  // No portable sandbox on linux without bwrap/landlock helpers — degrade.
  return { command: "/bin/bash", args: ["-lc", shellCommand] };
}

export function defaultSandboxSpec(opts: { cwd: string }): SandboxSpec {
  const env = process.env.LISA_SANDBOX;
  return {
    enabled: env === "1" || env === "true",
    allowNetwork: process.env.LISA_SANDBOX_NETWORK !== "0",
    cwd: opts.cwd,
  };
}
