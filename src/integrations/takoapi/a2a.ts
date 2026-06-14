/**
 * A2A task-state helpers for the TakoAPI observer (Dispatch D2b). Pure — the
 * unit under test. No I/O, no fs, so the mapping and parsing are verifiable
 * without the (still-evolving) live gateway.
 */
import type { AgentSessionState } from "../types.js";

/**
 * Map an A2A TaskState onto LISA's normalized session state. The A2A spec's
 * lifecycle states collapse onto our six:
 *   submitted | working           → working
 *   input-required | auth-required → waiting (the agent needs the user)
 *   completed                     → done
 *   failed | rejected             → error
 *   canceled                      → done (reason: canceled)
 *   anything else                 → unknown
 * Case-insensitive; tolerates the British "cancelled" spelling.
 */
export function taskStateToSessionState(
  taskState: string,
): { state: AgentSessionState; reason: string } {
  switch ((taskState || "").toLowerCase()) {
    case "submitted":
    case "working":
      return { state: "working", reason: taskState };
    case "input-required":
    case "auth-required":
      return { state: "waiting", reason: taskState };
    case "completed":
      return { state: "done", reason: "completed" };
    case "failed":
    case "rejected":
      return { state: "error", reason: taskState };
    case "canceled":
    case "cancelled":
      return { state: "done", reason: "canceled" };
    default:
      return { state: "unknown", reason: taskState || "unknown" };
  }
}

/**
 * Pull an A2A Task's state + id out of a /message response body, tolerating the
 * shapes a gateway/agent might return: a bare Task, one nested under JSON-RPC
 * `result`, or one under `task`; with the state at `status.state` (A2A) or a
 * flat `state`. Returns null when the body carries no task object (e.g. a plain
 * text reply or non-JSON) — the caller then treats a successful call as
 * `completed`. Pure.
 *
 * SECURITY: the response comes from an untrusted remote agent (2nd-order prompt
 * injection). We read ONLY the structural state/id strings here; the full reply
 * never enters the ledger or the hub.
 */
export function extractTaskState(
  body: string,
): { state: string; taskId?: string } | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null; // non-JSON (plain text reply) → no task object
  }
  if (!json || typeof json !== "object") return null;
  const j = json as Record<string, any>;
  // A2A task objects appear bare, under JSON-RPC `result`, or under `task`.
  const candidates = [j.result, j.task, j].filter(
    (t): t is Record<string, any> => !!t && typeof t === "object",
  );
  for (const task of candidates) {
    const state =
      (typeof task.status?.state === "string" && task.status.state) ||
      (typeof task.state === "string" && task.state) ||
      "";
    if (!state) continue;
    const taskId =
      (typeof task.id === "string" && task.id) ||
      (typeof task.taskId === "string" && task.taskId) ||
      "";
    return taskId ? { state, taskId } : { state };
  }
  return null;
}
