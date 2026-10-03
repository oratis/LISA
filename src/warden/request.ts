/**
 * Build the ActionRequest for one tool call: classification + digest +
 * redacted preview + the run's context. Pure apart from the id and the
 * symlink resolution the classifier does.
 */
import type { ToolDefinition } from "../types.js";
import type { SandboxMode } from "../sandbox/mode.js";
import { classifyToolCall, type Classification } from "./classify.js";
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
  /** MCP servers the user marked trusted in their rules. */
  trustedMcpServers?: readonly string[];
  /** Extra paths whose reads always ask (Warden state, provider keys). */
  sensitivePaths?: readonly string[];
  /** Home directory for credential locations (tests). */
  homeDir?: string;
  /** Per-home HMAC key for the digest. Omitted ⇒ a plain hash (in-memory use only). */
  digestKey?: Buffer;
  /** Has this exact URL already appeared in the conversation? */
  isKnownUrl?: (url: string) => boolean;
  now?: number;
}

export interface BuiltRequest {
  req: ActionRequest;
  /** Completing this call taints the run. */
  taintSource: boolean;
  /** Input keys in the order the approval card shows them. */
  primaryKeys: string[];
  classification: Classification;
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
    trustedMcpServers: ctx.trustedMcpServers,
    sensitivePaths: ctx.sensitivePaths,
    homeDir: ctx.homeDir,
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
    targetsComplete: c.targetsComplete,
    dataClasses: c.dataClasses,
    purpose: ctx.purpose ? ctx.purpose.slice(0, 240) : undefined,
    digest: payloadDigest(name, input, ctx.digestKey),
    preview: redactedPreview(name, input, c.primaryKeys),
    sandboxed: c.sandboxed,
    withinWorkspace: c.withinWorkspace,
    egress: c.egress,
    destination: c.destination,
    destinationKnown: c.url !== undefined && ctx.isKnownUrl?.(c.url) === true,
    sensitivePath: c.sensitivePath,
    tainted: ctx.tainted,
  };
  return { req, taintSource: c.taintSource, primaryKeys: c.primaryKeys, classification: c };
}
