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
 *   envelope  the task's envelope, narrowed to what Warden understands —
 *             and only when the user CONFIRMED it (src/tasks/confirmation.ts).
 *             An unconfirmed envelope pre-approves nothing: it only restricted
 *             the tools the run is offered. In a tainted run even a confirmed
 *             one does not cover exec, delete, send, publish, network writes
 *             or writes outside the run's workspace (policy.ts);
 *   taint     a run a watcher hit started is tainted from its first call (its
 *             prompt quotes an outsider's text), and so is a continued run that
 *             was tainted before;
 *   tenant    the task's uid and the home the run works in.
 *
 * An "ask" waits in the inbox like a chat turn's would. The engine is told
 * when the wait starts and ends (it shows the run as `awaiting_approval` and
 * stops its wall clock), and the user is told through the `reachOut` option —
 * the reach-out gate, source `approval`, never a push of its own. Approve and
 * the call runs; deny, expiry (THREAT_MODEL.md: about 10 minutes, then deny)
 * or a cancelled run, and the model is told it did not run.
 */
import { logWarn } from "../log.js";
import { taskApprovalNotice } from "../reachout/senders.js";
import type { ReachOutNotice, ReachOutResult } from "../reachout/types.js";
import type {
  TaskApprovalContext,
  TaskApprovalFactory,
  TaskApprovalHandle,
  TaskEnvelope as TaskEngineEnvelope,
} from "../tasks/types.js";
import { appendAudit, auditQuietly } from "./audit.js";
import { revokeTaskGrants } from "./grants.js";
import type { InboxItemView, WardenInbox } from "./inbox.js";
import { createWardenSession } from "./session.js";
import { isActionCategory, type RuntimeSurface, type TaskEnvelope } from "./types.js";

/** The reach-out gate, as the factory needs it (web/reachout-wiring.ts `makeServerReachOut`). */
export type ApprovalReachOut = (
  notice: ReachOutNotice,
) => Promise<Pick<ReachOutResult, "deliver" | "reason">>;

export interface TaskApprovalFactoryOptions {
  inbox: WardenInbox;
  surface: RuntimeSurface;
  /**
   * Tells the user an approval is waiting: the reach-out gate, source
   * `approval`. Its decision is final either way — a notice it withholds
   * leaves the item pending in the inbox, where the user can still answer it.
   */
  reachOut?: ApprovalReachOut;
  /** How long an "ask" waits. Default: the inbox's (10 minutes, THREAT_MODEL.md). */
  approvalTimeoutMs?: number;
  log?: (msg: string) => void;
  now?: () => number;
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
  const now = opts.now ?? Date.now;

  /** Tell the user. Never throws, never blocks or changes the approval itself. */
  const tell = async (ctx: TaskApprovalContext, item: InboxItemView): Promise<void> => {
    if (!opts.reachOut) return;
    try {
      const result = await opts.reachOut(
        taskApprovalNotice({
          uid: ctx.uid,
          approvalId: item.id,
          kind: ctx.origin.kind,
          title: ctx.title,
          tool: item.tool,
          expiresAt: item.expiresAt,
          now: now(),
        }),
      );
      if (!result.deliver) {
        log(
          `[warden] approval notice for task ${ctx.taskId} withheld (${result.reason}); the approval stays in the inbox`,
        );
      }
    } catch (err) {
      log(`[warden] approval notice for task ${ctx.taskId} failed: ${(err as Error).message}`);
    }
  };

  /** Revoke a task's task-scoped grants and audit each revocation. Throws if the store cannot be written. */
  const revoke = async (
    task: { taskId: string; uid: string | null; home: string },
    why: string,
    createdBefore?: number,
  ): Promise<void> => {
    const revoked = await revokeTaskGrants(
      task.taskId,
      task.home,
      now(),
      createdBefore !== undefined ? { createdBefore } : {},
    );
    for (const grant of revoked) {
      await auditQuietly(
        appendAudit(
          {
            at: new Date(now()).toISOString(),
            kind: "grant_revoked",
            uid: task.uid,
            grantId: grant.id,
            taskId: task.taskId,
            tool: grant.tool,
            category: grant.category,
            scope: grant.scope,
            note: why,
          },
          task.home,
          now(),
        ),
      );
    }
  };

  const factory: TaskApprovalFactory = async (ctx): Promise<TaskApprovalHandle> => {
    // "For this task" means for this run of it. One an earlier run left
    // behind — it crashed before its ending was recorded, or Warden was off
    // when it ended — must not cover this run. A store that cannot be written
    // fails the attempt (retried later) rather than run with it in place.
    await revoke(ctx, "left by an earlier run of the task", ctx.runStartedAt);
    const session = createWardenSession({
      surface: opts.surface,
      uid: ctx.uid,
      origin: { kind: ctx.origin.kind, id: ctx.origin.id },
      taskId: ctx.taskId,
      sandboxMode: ctx.sandboxMode,
      workspaceRoot: ctx.cwd,
      inbox: opts.inbox,
      tools: ctx.tools,
      // A pre-approval only when the user confirmed it; otherwise the
      // envelope has already done its job (restricting the toolset) and
      // every side effect the matrix leaves to it asks.
      envelope: ctx.envelopeConfirmed ? wardenEnvelope(ctx.envelope) : undefined,
      purpose: `${KIND_LABEL[ctx.origin.kind]} "${ctx.title.slice(0, 120)}"`,
      initialTaint: ctx.tainted,
      onTaint: ctx.onTaint,
      home: ctx.home,
      signal: ctx.signal,
      ...(opts.approvalTimeoutMs !== undefined
        ? { approvalTimeoutMs: opts.approvalTimeoutMs }
        : {}),
      // While the item is pending the run shows as awaiting approval, with its
      // wall clock stopped; the user is told once the item exists.
      onApprovalPending: async (item, req) => {
        await ctx.approvalWait.started({ tool: req.tool, approvalId: item.id });
        await tell(ctx, item);
      },
      onApprovalSettled: async (outcome) => {
        await ctx.approvalWait.ended({ approved: outcome.approved });
      },
      log,
    });
    return { approval: session.approval, observe: (event) => session.observe(event) };
  };
  // Grants scoped to the task end with the run, whatever its outcome.
  factory.runEnded = async (end) => {
    await revoke(end, "the task's run ended");
  };
  return factory;
}
