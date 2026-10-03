/**
 * What an unattended task run may touch.
 *
 * Three independent layers, each of which holds on its own:
 *   1. taskToolset()          — which tools the model is offered at all
 *                               (surface profile ∩ task envelope, minus the
 *                               task-management tools; a run triggered by a
 *                               watcher hit also loses everything a remote
 *                               channel is denied, because its input is
 *                               attacker-influenced);
 *   2. isVerifiedReadOnlyCall — an ALLOW-LIST: the calls positively known to
 *                               change nothing. Everything else — every other
 *                               builtin, every plugin / skill / MCP tool, and
 *                               every tool added in the future — is treated as
 *                               side-effecting. Used by the default gate AND by
 *                               the runner's exactly-once ledger;
 *   3. denySideEffects()      — the gate used when no approval factory is wired
 *                               (Warden absent): only verified read-only calls
 *                               pass. Never silently allowed.
 *
 * The list is an allow-list on purpose. A block-list ("deny what we know
 * mutates") lets through whatever nobody thought about — a diff tool whose
 * argument reaches `git` and can carry `--output=<path>`, a link tool that
 * opens a browser. `policy.test.ts` enumerates the registry and fails when a
 * tool is on neither list, so adding a tool forces the decision.
 */
import { createHash } from "node:crypto";
import type { ApprovalCallback } from "../agent.js";
import { restrictKbIngestToWatchlist } from "../kb/tool.js";
import { REMOTE_BLOCKED_TOOL_NAMES } from "../tools/registry.js";
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

type InputCheck = (input: Record<string, unknown>) => boolean;

const anyInput: InputCheck = () => true;
const optionalNumber = (v: unknown): boolean =>
  v === undefined || (typeof v === "number" && Number.isFinite(v));

/** `gh` actions that only read, and only with inputs that cannot become a flag. */
const GITHUB_READ_ACTIONS: ReadonlySet<string> = new Set([
  "issue_list",
  "issue_view",
  "pr_view",
  "run_list",
  "run_view",
  "release_list",
]);

/**
 * Verified read-only tools, each with the inputs it is read-only for.
 *
 * To add one: read its execute() and confirm that (a) it writes nothing and
 * starts no process that can, and (b) no model-supplied string reaches a
 * subprocess as its own argv element where it could be read as a flag. If the
 * answer depends on an input field, encode that here.
 */
export const UNATTENDED_READ_ONLY: Readonly<Record<string, InputCheck>> = Object.freeze({
  // Filesystem reads through the capability layer (paths are resolved, the
  // grep pattern is passed after `-e`).
  read: anyInput,
  grep: anyInput,
  ls: anyInput,
  // Lisa's own state, read side.
  memory_search: anyInput,
  soul_read: anyInput,
  // `limit` follows `-n` in a git argv: only a number is accepted here.
  soul_history: (i) => optionalNumber(i.limit),
  soul_diff: (i) => optionalNumber(i.limit),
  agent_recap: anyInput,
  kb_search: anyInput,
  kb_read: anyInput,
  kb_list: anyInput,
  kb_links: anyInput,
  // HTTP GET behind the SSRF guard; a search query.
  web_fetch: anyInput,
  web_search: anyInput,
  // `gh` reads. The issue / PR / run number is the only free argument.
  github: (i) =>
    typeof i.action === "string" &&
    GITHUB_READ_ACTIONS.has(i.action) &&
    optionalNumber(i.number) &&
    (i.state === undefined || i.state === "open" || i.state === "closed" || i.state === "all"),
});

/**
 * Builtins that are deliberately NOT allowed without an approval layer, with
 * why. This list grants nothing — a tool absent from both lists is denied too.
 * It exists so that the registry test can tell "decided: no" from "nobody
 * looked".
 */
export const UNATTENDED_DENIED: Readonly<Record<string, string>> = Object.freeze({
  // Filesystem / shell / process control.
  write: "writes files",
  edit: "writes files",
  apply_patch: "writes files",
  bash: "runs a shell",
  redeploy: "restarts the backend",
  run_checks: "runs project commands",
  // Arguments reach a subprocess (git / gh / npm) as free-form strings.
  review_diff: "its target is passed to git and can carry --output=<path>",
  repo_digest: "runs git with model-supplied arguments",
  pr_status: "runs gh with model-supplied arguments",
  npm_info: "runs npm with a model-supplied package spec",
  github_link: "can open a browser",
  // Other agents and processes.
  dispatch_agent: "launches an agent",
  run_on_plan: "launches an agent",
  signal_agent: "controls a running agent",
  compare_agents: "launches agents",
  scheduled_dispatch: "schedules agent launches",
  dispatch_status: "reads raw output of dispatched agents",
  list_agents: "observes other sessions; not needed unattended",
  inspect_agent: "observes other sessions; not needed unattended",
  advise_now: "raises a proactive suggestion",
  // Outbound / paid / external systems.
  mcp: "calls an external MCP server",
  takoapi: "spends the user's key on a remote agent",
  social_compose: "drafts outbound social posts",
  speak: "plays audio",
  transcribe: "sends audio to a provider",
  // Writes to Lisa's own state. Harmless-looking, but still writes: without an
  // approval layer there is no decision record for them, and a retried or
  // resumed run must not repeat them unseen.
  memory: "writes memory",
  set_mood: "changes the portrait",
  skill_manage: "writes skills (persistent prompt material)",
  soul_patch: "writes the soul",
  soul_journal: "writes the journal",
  soul_feel: "writes the soul",
  soul_object: "records an objection",
  desire_progress_log: "writes desire progress",
  desire_revise: "writes desires",
  desire_close: "writes desires",
  kb_add: "writes the knowledge base",
  kb_write: "writes the knowledge base",
  kb_ingest: "fetches a URL into the knowledge base",
  // Task management: never offered to a run, denied if it appears anyway.
  task_create: "creates unattended work",
  task_list: "task management",
  task_update: "edits unattended work",
  task_cancel: "task management",
  watch_create: "creates unattended work",
  task: "spawns a subagent with its own toolset",
});

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/** Is this exact call on the allow-list of verified read-only calls? */
export function isVerifiedReadOnlyCall(name: string, input: unknown): boolean {
  if (!Object.hasOwn(UNATTENDED_READ_ONLY, name)) return false;
  try {
    return UNATTENDED_READ_ONLY[name]!(asRecord(input));
  } catch {
    return false;
  }
}

/**
 * Might this call change something? True for everything that is not a
 * verified read-only call — including tools nobody has classified.
 */
export function isSideEffectingCall(name: string, input: unknown): boolean {
  return !isVerifiedReadOnlyCall(name, input);
}

/**
 * The gate for a run with no approval factory wired: only verified read-only
 * calls pass; everything else is refused with a reason the model can relay.
 */
export function denySideEffects(): ApprovalCallback {
  return (toolName, toolInput) => {
    if (isVerifiedReadOnlyCall(toolName, toolInput)) return { allow: true };
    return {
      allow: false,
      reason:
        `"${toolName}" is not on the list of read-only calls an unattended run may make, and this ` +
        `run has no approval path for anything else. It was not executed. Do not retry it or look ` +
        `for another way to do the same thing — finish what you can read-only and tell the user ` +
        `what needs them.`,
    };
  };
}

/**
 * The tools offered to one task run: the surface's capability-profile tools,
 * minus task management and the subagent spawner, narrowed to the task's
 * envelope when it names tools.
 *
 * `untrustedInput` — the run was started by a watcher hit, so part of its
 * prompt is text an outsider controls (a page, a feed title, a mail subject).
 * Such a run gets what a remote channel gets and no more: no skill_manage, no
 * knowledge-base writes or ingestion, none of the operational tools.
 */
export function taskToolset(
  surfaceTools: ToolDefinition[],
  envelope?: TaskEnvelope,
  opts: { untrustedInput?: boolean } = {},
): ToolDefinition[] {
  const allowed = envelope?.tools ? new Set(envelope.tools) : null;
  return (
    surfaceTools
      .filter((t) => !TASK_TOOL_NAMES.has(t.name) && t.name !== "task")
      .filter((t) => !allowed || allowed.has(t.name))
      .filter((t) => !opts.untrustedInput || !REMOTE_BLOCKED_TOOL_NAMES.has(t.name))
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
