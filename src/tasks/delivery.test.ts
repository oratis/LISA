import { test } from "node:test";
import assert from "node:assert/strict";
import type { StoredMessage } from "../types.js";
import { createTaskCardDeliver, formatTaskCard } from "./delivery.js";
import type { TaskNotice } from "./types.js";

function notice(over: Partial<TaskNotice> = {}): TaskNotice {
  return {
    id: "r_0123456789abcdef-task-result",
    uid: null,
    taskId: "t_0123456789ab",
    runId: "r_0123456789abcdef",
    title: "Morning brief",
    summary: "Two things need you today.",
    status: "succeeded",
    priority: "normal",
    kind: "task_result",
    ...over,
  };
}

function harness() {
  const history: StoredMessage[] = [];
  const events: Array<Record<string, unknown>> = [];
  const pushed: string[] = [];
  const deliver = createTaskCardDeliver({
    withConversation: (fn) =>
      fn({
        history,
        append: async (m) => {
          history.push(m);
        },
      }),
    broadcast: (e) => events.push(e),
    push: (_n, card) => pushed.push(card),
    now: () => Date.parse("2026-10-02T08:00:00Z"),
  });
  return { history, events, pushed, deliver };
}

test("a card names the task, carries the summary and its ref", () => {
  const card = formatTaskCard(
    notice({ artifacts: [{ kind: "link", title: "Report", value: "https://example.com/r" }] }),
  );
  assert.equal(
    card,
    "[task · Morning brief]\nTwo things need you today.\n- Report: https://example.com/r\n(ref r_0123456789abcdef-task-result)",
  );
  assert.match(formatTaskCard(notice({ kind: "watch_hit" })), /^\[watcher · /);
  assert.match(formatTaskCard(notice({ kind: "task_needs_you" })), /^\[task needs you · /);
  assert.match(formatTaskCard(notice({ kind: "task_failed" })), /^\[task failed · /);
});

test("delivering appends one assistant message, broadcasts task_result and pushes", async () => {
  const { history, events, pushed, deliver } = harness();
  assert.deepEqual(await deliver(notice()), { delivered: true });
  assert.equal(history.length, 1);
  assert.equal(history[0]!.role, "assistant");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "task_result");
  assert.equal(events[0]!.taskId, "t_0123456789ab");
  assert.equal(events[0]!.at, "2026-10-02T08:00:00.000Z");
  assert.equal(pushed.length, 1);
});

test("the same notice delivered again is acknowledged without a second card, event or push", async () => {
  const { history, events, pushed, deliver } = harness();
  await deliver(notice());
  assert.deepEqual(await deliver(notice()), { delivered: true, reason: "already_delivered" });
  assert.equal(history.length, 1);
  assert.equal(events.length, 1);
  assert.equal(pushed.length, 1);
  // A different notice for the same run is its own card.
  await deliver(notice({ id: "r_0123456789abcdef-task-failed", kind: "task_failed" }));
  assert.equal(history.length, 2);
});

test("a throwing push does not fail the delivery; a failing append does", async () => {
  const history: StoredMessage[] = [];
  const ok = createTaskCardDeliver({
    withConversation: (fn) => fn({ history, append: async (m) => void history.push(m) }),
    broadcast: () => {},
    push: () => {
      throw new Error("ntfy down");
    },
  });
  assert.deepEqual(await ok(notice()), { delivered: true });

  const broken = createTaskCardDeliver({
    withConversation: (fn) =>
      fn({
        history: [],
        append: async () => {
          throw new Error("disk full");
        },
      }),
    broadcast: () => assert.fail("must not broadcast a card that was not stored"),
  });
  await assert.rejects(broken(notice()), /disk full/);
});
