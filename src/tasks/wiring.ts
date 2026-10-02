/**
 * Process-wide injection points for the Task Engine.
 *
 * The engine itself never imports Warden or the Reach-out gate; those PRs call
 * the setters below at startup (one line each in server.ts / cli.ts). Until
 * then the defaults are deliberately SAFE:
 *   - no approval factory ⇒ the runner denies every side-effecting tool call;
 *   - no deliver          ⇒ results are recorded in the outbox as undelivered
 *     (reason "no_deliver_wired") and retried once a deliver is installed.
 */
import type { TaskApprovalFactory, TaskDeliver } from "./types.js";

let approvalFactory: TaskApprovalFactory | undefined;
let deliver: TaskDeliver | undefined;

/** Install (or clear, with undefined) the approval factory used for unattended runs. */
export function setTaskApprovalFactory(factory: TaskApprovalFactory | undefined): void {
  approvalFactory = factory;
}

export function getTaskApprovalFactory(): TaskApprovalFactory | undefined {
  return approvalFactory;
}

/** Install (or clear, with undefined) the delivery function for task results. */
export function setTaskDeliver(fn: TaskDeliver | undefined): void {
  deliver = fn;
}

export function getTaskDeliver(): TaskDeliver | undefined {
  return deliver;
}
