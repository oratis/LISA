/**
 * Capability access for tools (H1/H2 — docs/PLAN_HARNESS_ALIGNMENT_v1.0.md §2–3).
 *
 * `ToolContext.caps` is optional so that the dozen existing places that build a
 * ToolContext keep compiling. Tools therefore never read `ctx.caps` directly —
 * they go through `capsOf`, which supplies a default world when a caller has
 * not chosen one. One import per tool, no `?? LOCAL` repeated at fourteen call
 * sites where one could be forgotten.
 *
 * That default is where the sandbox actually takes effect for everybody: with
 * `danger-full-access` (the default mode) it is the plain local world, exactly
 * as before; with any bounded mode it is the sandboxed world, so `write`,
 * `edit` and `apply_patch` are confined too rather than only `bash`.
 *
 * SCOPE — this seam covers the seven primitive fs/shell tools
 * (read / write / edit / apply_patch / ls / grep / bash). The tools that spawn
 * in the *workspace* through `src/tools/exec-util.ts` (run_checks,
 * compare_agents, redeploy, dispatch_agent, and the repo/PR/review helpers)
 * still use a raw `spawn` and do NOT pass through `caps.shell` yet — a sandbox
 * provider bounds the primitives but not those. Routing the exec-util family
 * through the seam is the follow-up that makes "bound the world in one place"
 * literally true; until then, do not assume `capsOf` is the *only* path to the
 * filesystem or a subprocess.
 */

import type { ToolContext } from "../types.js";
import { LOCAL_CAPABILITIES } from "./local.js";
import { createSandboxedCapabilities } from "./sandboxed.js";
import { defaultSandboxSpec } from "../sandbox/sandbox.js";
import { modeIsBounded, type SandboxMode } from "../sandbox/mode.js";
import type { Capabilities } from "./types.js";

/**
 * The execution world for a workspace when no caller supplied one. Resolved
 * per call rather than cached: the mode comes from the environment, and a
 * cached world would quietly outlive a change to it.
 */
export function defaultCapabilitiesFor(
  cwd: string,
  mode?: SandboxMode,
): Capabilities {
  const spec = defaultSandboxSpec({ cwd, mode });
  if (!modeIsBounded(spec.mode)) return LOCAL_CAPABILITIES;
  return createSandboxedCapabilities({ root: cwd, spec });
}

export function capsOf(ctx: ToolContext): Capabilities {
  // A caller-supplied world wins; otherwise resolve from the turn's pinned mode
  // (H2 — a session's `header.sandboxMode`), falling back to the environment
  // default only when nothing was pinned. This is the single point where the
  // per-session pin actually takes effect for fs/shell tools.
  return ctx.caps ?? defaultCapabilitiesFor(ctx.cwd, ctx.sandboxMode);
}

export { LOCAL_CAPABILITIES, localFs, localShell } from "./local.js";
export { createSandboxedCapabilities } from "./sandboxed.js";
export { createMemoryCapabilities, createMemoryFs, refusingShell } from "./memory.js";
export type {
  Capabilities,
  ExecOptions,
  ExecResult,
  FsCapability,
  FsDirEntry,
  FsStat,
  ShellCapability,
} from "./types.js";
