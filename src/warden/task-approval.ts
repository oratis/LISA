/**
 * Warden for Task Engine runs — the approval factory the web server installs
 * when it runs in Warden mode (`--approval warden` / `LISA_APPROVAL=warden`).
 *
 * Without it the engine keeps its read-only allow-list (src/tasks/policy.ts):
 * an unattended run gets more than verified read-only calls ONLY with Warden
 * on. With it, every run gets its own Warden session:
 *
 *   origin    `task` / `routine` / `watcher` with the task id, so the default
 *             matrix's task column applies ("preapproved" = covered by the
 *             task's capability envelope, otherwise ask);
 *   envelope  the task's envelope, narrowed to what Warden understands;
 *   taint     a run a watcher hit started is tainted from its first call (its
 *             prompt quotes an outsider's text), and so is a continued run that
 *             was tainted before;
 *   tenant    the task's uid and the home the run works in.
 *
 * An "ask" waits in the inbox like a chat turn's would. The engine is told
 * when the wait starts and ends (it shows the run as `awaiting_approval` and
 * stops its wall clock), and the user is told through `notify` — which the
 * server points at `reachOut()` with source `approval`.
 */
import { logWarn } from "../log.js";
import type {
  TaskApprovalContext,
  TaskApprovalFactory,
  TaskApprovalHandle,
  TaskEnvelope as TaskEngineEnvelope,
} from "../tasks/types.js";
import type { WardenInbox } from "./inbox.js";
import { createWardenSession } from "./session.js";
import { isActionCategory, type RuntimeSurface, type TaskEnvelope } from "./types.js";

export interface TaskApprovalFactoryOptions {
  inbox: WardenInbox;
  surface: RuntimeSurface;
  /** How long an "ask" waits. Default: the inbox's (10 minutes, THREAT_MODEL.md). */
  approvalTimeoutMs?: number;
  log?: (msg: string) => void;
}

/**
 * The task's envelope as Warden reads it. Categories Warden does not know
 * ("web", "mail" — informational labels) are dropped rather than guessed at:
 * an envelope can only ever cover what it names exactly.
 */
export function wardenEnvelope(envelope: TaskEngineEnvelope | undefined): TaskEnvelope | undefined {
  if (!envelope) return undefined;
  const out: TaskEnvelope = {};
  if (envelope.categories) out.categories = envelope.categories.filter(isActionCategory);
  if (envelope.tools) out.tools = [...envelope.tools];
  if (envelope.targets) out.targets = [...envelope.targets];
  return out;
}

const KIND_LABEL: Record<TaskApprovalContext["origin"]["kind"], string> = {
  task: "task",
  routine: "routine",
  watcher: "watcher",
};

export function createTaskApprovalFactory(opts: TaskApprovalFactoryOptions): TaskApprovalFactory {
  const log = opts.log ?? logWarn;
  const factory: TaskApprovalFactory = (ctx): TaskApprovalHandle => {
    const session = createWardenSession({
      surface: opts.surface,
      uid: ctx.uid,
      origin: { kind: ctx.origin.kind, id: ctx.origin.id },
      taskId: ctx.taskId,
      sandboxMode: ctx.sandboxMode,
      workspaceRoot: ctx.cwd,
      inbox: opts.inbox,
      tools: ctx.tools,
      envelope: wardenEnvelope(ctx.envelope),
      purpose: `${KIND_LABEL[ctx.origin.kind]} "${ctx.title.slice(0, 120)}"`,
      initialTaint: ctx.tainted,
      onTaint: ctx.onTaint,
      home: ctx.home,
      signal: ctx.signal,
      ...(opts.approvalTimeoutMs !== undefined
        ? { approvalTimeoutMs: opts.approvalTimeoutMs }
        : {}),
      log,
    });
    return { approval: session.approval, observe: (event) => session.observe(event) };
  };
  return factory;
}
