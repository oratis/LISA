/**
 * Default delivery: a task result becomes a card in Lisa's conversation.
 *
 * This is the channel of last resort the web server registers until the
 * Reach-out gate (W3) is wired in front of it. It does what an idle note does
 * today — append an assistant message to the session, tell open clients over
 * SSE — and nothing cleverer.
 *
 * Idempotent on `notice.id`: the card text carries a `(ref <id>)` line, and a
 * notice whose ref is already in the conversation is acknowledged without a
 * second append. The append IS the commit point, so the outbox redelivering
 * after a crash can never produce two cards.
 */
import type { StoredMessage } from "../types.js";
import type { TaskDeliver, TaskNotice } from "./types.js";

const HEADLINE: Record<TaskNotice["kind"], string> = {
  task_result: "task",
  watch_hit: "watcher",
  task_needs_you: "task needs you",
  task_failed: "task failed",
};

function refLine(id: string): string {
  return `(ref ${id})`;
}

/** The card as it is stored in the conversation and shown to the user. */
export function formatTaskCard(notice: TaskNotice): string {
  const lines = [`[${HEADLINE[notice.kind]} · ${notice.title}]`, notice.summary.trim()];
  for (const artifact of notice.artifacts ?? []) {
    lines.push(`- ${artifact.title ? `${artifact.title}: ` : ""}${artifact.value}`);
  }
  lines.push(refLine(notice.id));
  return lines.join("\n");
}

function hasCard(history: StoredMessage[], id: string): boolean {
  const ref = refLine(id);
  // Recent history only: a card is delivered within moments of its run.
  for (const message of history.slice(-200)) {
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string") {
      if (message.content.includes(ref)) return true;
      continue;
    }
    for (const block of message.content) {
      if (block.type === "text" && block.text.includes(ref)) return true;
    }
  }
  return false;
}

/** The slice of a conversation the deliver needs. */
export interface CardConversation {
  history: StoredMessage[];
  /** Persist the message and add it to `history`. */
  append(message: StoredMessage): Promise<void>;
}

export interface CardDeliverDeps {
  /**
   * Run `fn` against the conversation of the tenant in the CURRENT home scope,
   * serialised with that conversation's chat turns.
   */
  withConversation<T>(fn: (conversation: CardConversation) => Promise<T>): Promise<T>;
  /** Tenant-aware SSE broadcast. */
  broadcast(event: Record<string, unknown>): void;
  /** Optional push (the existing PushBridge idle path). Best-effort. */
  push?(notice: TaskNotice, card: string): void;
  now?: () => number;
}

export function createTaskCardDeliver(deps: CardDeliverDeps): TaskDeliver {
  return async (notice) => {
    const card = formatTaskCard(notice);
    const fresh = await deps.withConversation(async (conversation) => {
      if (hasCard(conversation.history, notice.id)) return false;
      await conversation.append({ role: "assistant", content: [{ type: "text", text: card }] });
      return true;
    });
    if (!fresh) return { delivered: true, reason: "already_delivered" };
    const at = new Date((deps.now ?? Date.now)()).toISOString();
    deps.broadcast({
      type: "task_result",
      id: notice.id,
      taskId: notice.taskId,
      runId: notice.runId,
      kind: notice.kind,
      title: notice.title,
      summary: notice.summary,
      status: notice.status,
      priority: notice.priority,
      ...(notice.artifacts ? { artifacts: notice.artifacts } : {}),
      text: card,
      at,
    });
    try {
      deps.push?.(notice, card);
    } catch {
      // Push is a courtesy on top of the card; it must not fail the delivery.
    }
    return { delivered: true };
  };
}
