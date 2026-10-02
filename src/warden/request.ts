/**
 * Build the ActionRequest for one tool call: classification + digest +
 * redacted preview + the run's context. Pure apart from the id.
 */
import type { ToolDefinition } from "../types.js";
import type { SandboxMode } from "../sandbox/mode.js";
import { classifyToolCall } from "./classify.js";
import { payloadDigest, redactedPreview } from "./preview.js";
import { newId } from "./store.js";
import type { ActionRequest, DataClass, Origin, RuntimeSurface } from "./types.js";

export interface RequestContext {
  uid: string | null;
  surface: RuntimeSurface;
  origin: Origin;
  taskId?: string;
  workspaceRoot: string;
  sandboxMode: SandboxMode;
  /** Untrusted external content already entered this run. */
  tainted: boolean;
  purpose?: string;
  dataClassHints?: DataClass[];
  now?: number;
}

export interface BuiltRequest {
  req: ActionRequest;
  /** Completing this call taints the run. */
  taintSource: boolean;
}

export function buildActionRequest(
  name: string,
  input: unknown,
  tool: ToolDefinition | undefined,
  ctx: RequestContext,
): BuiltRequest {
  const c = classifyToolCall(name, input, tool, {
    workspaceRoot: ctx.workspaceRoot,
    sandboxMode: ctx.sandboxMode,
    dataClassHints: ctx.dataClassHints,
  });
  const req: ActionRequest = {
    id: newId("act"),
    at: new Date(ctx.now ?? Date.now()).toISOString(),
    uid: ctx.uid,
    surface: ctx.surface,
    origin: ctx.origin,
    taskId: ctx.taskId,
    tool: name,
    method: c.method,
    connector: c.connector,
    category: c.category,
    targets: c.targets,
    dataClasses: c.dataClasses,
    purpose: ctx.purpose ? ctx.purpose.slice(0, 240) : undefined,
    digest: payloadDigest(name, input),
    preview: redactedPreview(name, input),
    sandboxed: c.sandboxed,
    withinWorkspace: c.withinWorkspace,
    egress: c.egress,
    tainted: ctx.tainted,
  };
  return { req, taintSource: c.taintSource };
}
