/**
 * What an unattended task run may touch.
 *
 * Three independent layers, each of which holds on its own:
 *   1. taskToolset()         — which tools the model is offered at all
 *                              (surface profile ∩ task envelope, minus the
 *                              task-management tools themselves);
 *   2. isSideEffectingCall() — which calls change something outside Lisa's own
 *                              notes. Used by the default gate AND by the
 *                              runner's exactly-once ledger;
 *   3. denySideEffects()     — the gate used when no approval factory is wired
 *                              (Warden absent): every side-effecting call is
 *                              refused. Never silently allowed.
 */
import { createHash } from "node:crypto";
import type { ApprovalCallback } from "../agent.js";
import { DEFAULT_MUTATING_ACTIONS, DEFAULT_MUTATING_TOOLS, isMutatingCall } from "../approval.js";
import { restrictKbIngestToWatchlist } from "../kb/tool.js";
import { AUTONOMOUS_BLOCKED_TOOL_NAMES, buildToolRegistry } from "../tools/registry.js";
import type { ToolDefinition } from "../types.js";
import type { TaskEnvelope } from "./types.js";

/** Tools that manage tasks. A running task is never offered them: tasks do not spawn tasks. */
export const TASK_TOOL_NAMES: ReadonlySet<string> = new Set([
  "task_create",
  "task_list",
  "task_update",
  "task_cancel",
  "watch_create",
]);

const MUTATING_CFG = {
  mode: "ask-mutating" as const,
  mutatingTools: DEFAULT_MUTATING_TOOLS,
  mutatingActions: DEFAULT_MUTATING_ACTIONS,
};

/**
 * Action-dispatched tools that sit on the autonomous block-list as a whole but
 * whose non-mutating actions are harmless reads (approval.ts already knows
 * which of their actions write).
 */
const READS_ALLOWED: ReadonlySet<string> = new Set(Object.keys(DEFAULT_MUTATING_ACTIONS));

let builtinNames: Set<string> | null = null;
function isBuiltin(name: string): boolean {
  builtinNames ??= new Set(buildToolRegistry({ includeVoice: true }).map((t) => t.name));
  return builtinNames.has(name);
}

/**
 * Does this call change state outside Lisa's own soul / memory / knowledge
 * base? Deliberately conservative — anything not positively known to be
 * harmless counts:
 *   - approval.ts's mutating tools and mutating actions (write, edit, bash, …);
 *   - the operational tools unattended self-driven runs are never given
 *     (dispatch, redeploy, mcp, takoapi, social drafts, …);
 *   - every tool that is not a LISA builtin (executable skills, plugins, MCP
 *     tools): their `readOnlyHint` is a UX hint, not proof.
 */
export function isSideEffectingCall(name: string, input: unknown): boolean {
  if (isMutatingCall(MUTATING_CFG, name, input)) return true;
  if (AUTONOMOUS_BLOCKED_TOOL_NAMES.has(name)) return !READS_ALLOWED.has(name);
  if (TASK_TOOL_NAMES.has(name)) return true;
  return !isBuiltin(name);
}

/**
 * The gate for a run with no approval factory wired: refuse every
 * side-effecting call, with a reason the model can relay to the user.
 */
export function denySideEffects(): ApprovalCallback {
  return (toolName, toolInput) => {
    if (!isSideEffectingCall(toolName, toolInput)) return { allow: true };
    return {
      allow: false,
      reason:
        `"${toolName}" changes things outside your own notes, and this unattended run has no ` +
        `approval path for that. It was not executed. Do not retry it or look for another way ` +
        `to do the same thing — finish what you can read-only and tell the user what needs them.`,
    };
  };
}

/**
 * The tools offered to one task run: the surface's capability-profile tools,
 * minus task management and the subagent spawner, narrowed to the task's
 * envelope when it names tools.
 */
export function taskToolset(
  surfaceTools: ToolDefinition[],
  envelope?: TaskEnvelope,
): ToolDefinition[] {
  const allowed = envelope?.tools ? new Set(envelope.tools) : null;
  return (
    surfaceTools
      .filter((t) => !TASK_TOOL_NAMES.has(t.name) && t.name !== "task")
      .filter((t) => !allowed || allowed.has(t.name))
      // An unattended run may only pull watch-listed domains into the KB (D3).
      .map(restrictKbIngestToWatchlist)
  );
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Idempotency key of a tool call: sha256(tool + canonical JSON of its input). */
export function digestCall(name: string, input: unknown): string {
  return createHash("sha256")
    .update(name)
    .update("\n")
    .update(JSON.stringify(canonical(input)) ?? "null")
    .digest("hex");
}
