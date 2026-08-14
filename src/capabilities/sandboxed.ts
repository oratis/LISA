/**
 * Sandboxed provider (H2 — docs/PLAN_HARNESS_ALIGNMENT_v1.0.md §3).
 *
 * Before this, `wrapForSandbox` had exactly one caller: the `bash` tool. So
 * with LISA_SANDBOX=1 a shell command was confined to cwd while `write`,
 * `edit` and `apply_patch` — which resolve `path.resolve(ctx.cwd, input.path)`
 * and accept absolute paths and `../` alike — could still reach the whole disk.
 * A user who turned the sandbox on had a guarantee they did not have.
 *
 * Both halves now read one `SandboxMode` from one spec, which is what makes it
 * structurally impossible for them to bound to different roots again.
 *
 * What each mode means here:
 *
 *  | mode                | fs reads | fs writes            | shell            |
 *  |---------------------|----------|----------------------|------------------|
 *  | read-only           | anywhere | refused              | no writable path |
 *  | workspace-write     | anywhere | root + temp only     | root + temp only |
 *  | danger-full-access  | anywhere | anywhere             | unconfined       |
 *
 * Reads are deliberately unbounded in every mode, because Seatbelt's policy
 * grants `file-read*` unconditionally: bounding fs reads while shell reads stay
 * open would recreate the very asymmetry this fixes, with the added cost of
 * breaking every tool that reads outside the workspace (~/.lisa included).
 * "What may be read at all" is decided a layer up, by the tool subsets.
 */

import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { localFs, localShell } from "./local.js";
import type { Capabilities, ExecOptions, ExecResult, FsCapability } from "./types.js";
import { wrapForSandbox, wrapArgvForSandbox, type SandboxSpec } from "../sandbox/sandbox.js";
import { modeIsBounded, modeAllowsWrites } from "../sandbox/mode.js";

export interface SandboxedOptions {
  /** The workspace root writes are confined to under `workspace-write`. */
  root: string;
  spec: SandboxSpec;
  /**
   * Whether the system temp directories count as writable under
   * `workspace-write`. Defaults to true, matching the Seatbelt policy.
   *
   * This is a deliberate looseness, not an oversight: `bash` can write to /tmp
   * under the same mode, so refusing `write` the same access would be theatre —
   * and an fs bound that disagrees with the shell bound is precisely the defect
   * H2 exists to remove. Set false only to exercise pure workspace confinement.
   */
  allowTemp?: boolean;
}

/**
 * Is `abs` inside `root`? Compares resolved *real* paths so a symlink planted
 * inside the workspace cannot be used to write through it to somewhere else.
 * Since the target usually does not exist yet, it walks up to the nearest
 * existing ancestor and realpaths that.
 */
async function isInside(abs: string, root: string): Promise<boolean> {
  const realRoot = await realpathOrSelf(root);
  const realAbs = await realpathOfNearestExisting(abs);
  return realAbs === realRoot || realAbs.startsWith(realRoot + path.sep);
}

async function realpathOrSelf(p: string): Promise<string> {
  try {
    return await fsp.realpath(p);
  } catch {
    return p;
  }
}

async function realpathOfNearestExisting(abs: string): Promise<string> {
  let current = abs;
  const trailing: string[] = [];
  // Bounded by path depth; a resolved path cannot loop.
  for (;;) {
    try {
      const real = await fsp.realpath(current);
      return trailing.length ? path.join(real, ...trailing.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return abs; // hit the filesystem root
      trailing.push(path.basename(current));
      current = parent;
    }
  }
}

function writableRoots(opts: SandboxedOptions): string[] {
  // Mirrors the Seatbelt policy's writable subpaths so the two halves agree.
  if (opts.allowTemp === false) return [opts.root];
  return [opts.root, os.tmpdir(), "/tmp", "/private/tmp"];
}

function createSandboxedFs(opts: SandboxedOptions): FsCapability {
  const mode = opts.spec.mode;

  const assertWritable = async (abs: string): Promise<void> => {
    if (!modeAllowsWrites(mode)) {
      throw new Error(
        `sandbox mode "${mode}" forbids writes — refusing to modify ${abs}`,
      );
    }
    if (!modeIsBounded(mode)) return;
    for (const root of writableRoots(opts)) {
      if (await isInside(abs, root)) return;
    }
    throw new Error(
      `sandbox mode "${mode}" confines writes to ${opts.root} — refusing to write ${abs}`,
    );
  };

  return {
    // Resolution only: the shell resolves nothing either, and reads are
    // unbounded by design (see the module header). The gate is on the write
    // operations, in one place, for every tool at once.
    resolvePath: localFs.resolvePath,
    stat: localFs.stat,
    exists: localFs.exists,
    readFile: localFs.readFile,
    readdir: localFs.readdir,
    async writeFile(abs: string, content: string): Promise<void> {
      await assertWritable(abs);
      await localFs.writeFile(abs, content);
    },
    async unlink(abs: string): Promise<void> {
      await assertWritable(abs);
      await localFs.unlink(abs);
    },
  };
}

export function createSandboxedCapabilities(opts: SandboxedOptions): Capabilities {
  return {
    fs: createSandboxedFs(opts),
    shell: {
      async run(command: string, execOpts: ExecOptions): Promise<ExecResult> {
        // Throws SANDBOX_UNAVAILABLE when the host cannot enforce the mode —
        // the command does not run unconfined behind the user's back.
        const wrapped = await wrapForSandbox(
          { ...opts.spec, cwd: execOpts.cwd },
          command,
        );
        try {
          return await localShell.exec(wrapped.command, wrapped.args, execOpts);
        } finally {
          await wrapped.cleanup?.();
        }
      },
      async exec(command: string, args: string[], execOpts: ExecOptions): Promise<ExecResult> {
        // MED-3: exec used to run raw/unconfined even in bounded modes, so a
        // mutating program invoked via argv (or a change to grep's args) would
        // silently escape read-only/workspace-write. Route it through the same
        // fail-closed confinement as run() so ONE mode governs both shell halves.
        const wrapped = await wrapArgvForSandbox(
          { ...opts.spec, cwd: execOpts.cwd },
          command,
          args,
        );
        try {
          return await localShell.exec(wrapped.command, wrapped.args, execOpts);
        } finally {
          await wrapped.cleanup?.();
        }
      },
    },
  };
}
