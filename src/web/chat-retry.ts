/**
 * Retrying a chat turn without duplicating it (#491).
 *
 * A client disconnect aborts the turn on purpose: Pocket Stop relies on it.
 * But once the model has answered once, the agent loop has already written
 * the user message (and any tool exchange) to the transcript, so a retry
 * used to append the same message a second time, both in the history people
 * see and in the model context.
 *
 * These pure helpers let the chat route recognise that case and continue the
 * cut-off turn instead of starting a second copy of it.
 */
import type { StoredMessage } from "../types.js";

type Block = Exclude<StoredMessage["content"], string>[number];

function blocks(message: StoredMessage): Block[] | null {
  return Array.isArray(message.content) ? message.content : null;
}

function hasToolUse(message: StoredMessage): boolean {
  return blocks(message)?.some((b) => b.type === "tool_use") ?? false;
}

/**
 * The typed text of a user turn: a string body, or its first text block.
 * null for a tool-result message, which comes from the agent, not a person.
 */
function userTurn(message: StoredMessage): { text: string; attachments: number } | null {
  if (message.role !== "user") return null;
  if (typeof message.content === "string") return { text: message.content, attachments: 0 };
  const list = blocks(message)!;
  if (list.some((b) => b.type === "tool_result")) return null;
  const first = list[0];
  return first?.type === "text"
    ? { text: first.text, attachments: list.length - 1 }
    : { text: "", attachments: list.length };
}

/**
 * Index of the last message a person typed when it is `text` (with
 * `attachments` files) and no final assistant reply follows it: only tool
 * calls and their results, from a turn a disconnect cut short. -1 otherwise,
 * including when the message was answered, because sending the same words
 * again after a reply is a new turn.
 */
export function unfinishedTurnIndex(
  history: readonly StoredMessage[],
  text: string,
  attachments: number,
): number {
  // Equal attachment counts do not imply equal files. Without a request id or
  // content comparison, a new upload must never be mistaken for an old retry.
  if (attachments > 0) return -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!;
    if (message.role === "assistant") {
      if (!hasToolUse(message)) return -1; // the turn got its reply
      continue;
    }
    const turn = userTurn(message);
    if (!turn) continue; // tool results
    return turn.text === text && turn.attachments === attachments ? i : -1;
  }
  return -1;
}

/**
 * When the transcript ends on tool calls that never got results (the turn was
 * cut off while a tool ran), the user message that closes them as interrupted.
 * Providers reject a tool call without its result once anything follows it.
 */
export function closeInterruptedToolCalls(history: readonly StoredMessage[]): StoredMessage | null {
  const last = history[history.length - 1];
  if (!last || last.role !== "assistant") return null;
  const ids = (blocks(last) ?? []).flatMap((b) => (b.type === "tool_use" ? [b.id] : []));
  if (ids.length === 0) return null;
  return {
    role: "user",
    content: ids.map((id) => ({
      type: "tool_result" as const,
      tool_use_id: id,
      content: "[interrupted] The connection closed before this tool finished.",
      is_error: true,
    })),
  };
}
