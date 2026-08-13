/**
 * Capability access for tools (H1 — docs/PLAN_HARNESS_ALIGNMENT_v1.0.md §2).
 *
 * `ToolContext.caps` is optional so that the dozen existing places that build a
 * ToolContext keep compiling and keep their current behaviour. Tools therefore
 * never read `ctx.caps` directly — they go through `capsOf`, which supplies the
 * local world when a caller has not chosen one. One import per tool, no
 * `?? LOCAL` repeated at fourteen call sites where one could be forgotten.
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
