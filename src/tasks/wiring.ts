/**
 * Process-wide injection points for the Task Engine.
 *
 * The engine itself never imports Warden or the Reach-out gate; those PRs call
 * the setters below at startup (one line each in server.ts / cli.ts). Until
 * then the defaults are deliberately SAFE:
 *   - no approval factory ⇒ the runner denies every side-effecting tool call;
 *   - no deliver          ⇒ results fall back to the host's default channel
 *     (the web server registers a conversation task card); with no host
 *     channel either — the heartbeat CLI — they wait in the outbox, durably,
 *     for the next process that has one.
 */
import type { TaskApprovalFactory, TaskDeliver } from "./types.js";

let approvalFactory: TaskApprovalFactory | undefined;
let deliver: TaskDeliver | undefined;
let defaultDeliver: TaskDeliver | undefined;

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

/**
 * The host's channel of last resort (web server: a task card in Lisa's
 * conversation + SSE). Used when no deliver is installed; a gate installed via
 * setTaskDeliver can call it to pass a notice through.
 */
export function setDefaultTaskDeliver(fn: TaskDeliver | undefined): void {
  defaultDeliver = fn;
}

export function getDefaultTaskDeliver(): TaskDeliver | undefined {
  return defaultDeliver;
}
