/**
 * Capability access for tools (H1 — docs/PLAN_HARNESS_ALIGNMENT_v1.0.md §2).
 *
 * `ToolContext.caps` is optional so that the dozen existing places that build a
 * ToolContext keep compiling and keep their current behaviour. Tools therefore
 * never read `ctx.caps` directly — they go through `capsOf`, which supplies the
 * local world when a caller has not chosen one. One import per tool, no
 * `?? LOCAL` repeated at fourteen call sites where one could be forgotten.
 *
 * SCOPE (H1) — this seam covers the seven primitive fs/shell tools
 * (read / write / edit / apply_patch / ls / grep / bash). The tools that spawn
 * in the *workspace* through `src/tools/exec-util.ts` (run_checks,
 * compare_agents, redeploy, dispatch_agent, and the repo/PR/review helpers)
 * still use a raw `spawn` and do NOT pass through `caps.shell` yet. A sandbox
 * provider swapped in at `ctx.caps` (H2) therefore bounds the primitives but
 * not those — routing the exec-util family through the seam is the follow-up
 * that makes "bound the world in one place" literally true. Until then, do not
 * assume `capsOf` is the *only* path to the filesystem or a subprocess.
 */

import type { ToolContext } from "../types.js";
import { LOCAL_CAPABILITIES } from "./local.js";
import type { Capabilities } from "./types.js";

export function capsOf(ctx: ToolContext): Capabilities {
  return ctx.caps ?? LOCAL_CAPABILITIES;
}

export { LOCAL_CAPABILITIES, localFs, localShell } from "./local.js";
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
