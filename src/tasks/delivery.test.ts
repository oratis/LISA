import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReachOutTransports } from "../reachout/deliver.js";
import { DeferQueue } from "../reachout/defer.js";
import { readLedger, type LedgerNoticeEntry } from "../reachout/ledger.js";
import { defaultReachOutSettings, saveReachOutSettings } from "../reachout/settings.js";
import type { ReachOutNotice, ReachOutResult } from "../reachout/types.js";
import type { StoredMessage } from "../types.js";
import type { PushEvent } from "../web/push.js";
import { makeServerReachOut } from "../web/reachout-wiring.js";
import { createTaskCardDeliver, formatTaskCard, reachOutNoticeFor, type TaskReachOut } from "./delivery.js";
import { drainOutbox, enqueueNotice, listOutbox } from "./outbox.js";
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

// ── pure ──

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

test("what the gate is told: source by kind, the user's own result, no dedupe key", () => {
  assert.deepEqual(reachOutNoticeFor(notice()), {
    uid: null,
    source: "task",
    kind: "task_result",
    title: "Morning brief",
    body: "Two things need you today.",
    priority: "normal",
    actionable: false,
  });
  const hit = reachOutNoticeFor(notice({ kind: "watch_hit", priority: "high", uid: "u1" }));
  assert.equal(hit.source, "watcher");
  assert.equal(hit.priority, "high");
  assert.equal(hit.uid, "u1");
  assert.equal(reachOutNoticeFor(notice({ kind: "task_needs_you" })).actionable, true);
  assert.equal(reachOutNoticeFor(notice({ kind: "task_failed" })).source, "task");
  for (const kind of ["task_result", "watch_hit", "task_needs_you", "task_failed"] as const) {
    const n = reachOutNoticeFor(notice({ kind }));
    assert.equal(n.dedupeKey, undefined);
    assert.equal(n.solicited, undefined, "left to the gate: task and watcher are solicited by nature");
  }
});

// ── with a scripted gate ──

/** A gate that allows the given channels and runs their transports, like reachOut(). */
function scriptedGate(channels: Array<"inapp" | "push">, reason: ReachOutResult["reason"] = "solicited") {
  const asked: ReachOutNotice[] = [];
  const gate: TaskReachOut = async (n, transports) => {
    asked.push(n);
    const stamped = { ...n, id: `ro_${asked.length}`, from: "Lisa" as const, ai: true as const, at: "2026-10-02T08:00:00.000Z" };
    for (const channel of channels) {
      try {
        if (channel === "inapp") await transports.inapp(stamped);
        else await transports.push(stamped, { silent: false });
      } catch {
        // reachOut() never throws to a sender: a failed transport is logged and skipped
      }
    }
    return { id: stamped.id, deliver: channels.length > 0, channels, reason };
  };
  return { gate, asked };
}

function conversation(over: { failAppend?: boolean } = {}) {
  const history: StoredMessage[] = [];
  return {
    history,
    withConversation: <T>(fn: (c: { history: StoredMessage[]; append(m: StoredMessage): Promise<void> }) => Promise<T>) =>
      fn({
        history,
        append: async (m) => {
          if (over.failAppend) throw new Error("disk full");
          history.push(m);
        },
      }),
  };
}

test("allowed: one card in the conversation, a task_result event, the gate's note and the push", async () => {
  const { gate, asked } = scriptedGate(["inapp", "push"]);
  const convo = conversation();
  const events: Array<Record<string, unknown>> = [];
  const notes: string[] = [];
  const pushes: string[] = [];
  const deliver = createTaskCardDeliver({
    reachOut: gate,
    withConversation: convo.withConversation,
    broadcast: (e) => events.push(e),
    transports: {
      inapp: (n) => void notes.push(n.id),
      push: (n) => void pushes.push(n.id),
    },
  });
  assert.deepEqual(await deliver(notice()), { delivered: true });
  assert.equal(asked.length, 1);
  assert.equal(convo.history.length, 1);
  assert.equal(convo.history[0]!.role, "assistant");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "task_result");
  assert.equal(events[0]!.reachOutId, "ro_1");
  assert.equal(events[0]!.from, "Lisa");
  assert.equal(events[0]!.at, "2026-10-02T08:00:00.000Z");
  assert.deepEqual(notes, ["ro_1"]);
  assert.deepEqual(pushes, ["ro_1"]);
});

test("redelivery of a stored card never reaches the gate again: no second card, event or push", async () => {
  const { gate, asked } = scriptedGate(["inapp", "push"]);
  const convo = conversation();
  const events: unknown[] = [];
  const pushes: string[] = [];
  const deliver = createTaskCardDeliver({
    reachOut: gate,
    withConversation: convo.withConversation,
    broadcast: (e) => events.push(e),
    transports: { push: (n) => void pushes.push(n.id) },
  });
  await deliver(notice());
  assert.deepEqual(await deliver(notice()), { delivered: true, reason: "already_delivered" });
  assert.equal(asked.length, 1, "the gate (and its ledger) saw it once");
  assert.equal(convo.history.length, 1);
  assert.equal(events.length, 1);
  assert.equal(pushes.length, 1);
  // A different notice for the same run is its own card.
  await deliver(notice({ id: "r_0123456789abcdef-task-failed", kind: "task_failed" }));
  assert.equal(convo.history.length, 2);
});

test("withheld by the gate: nothing is stored or sent, and the outcome is final with the gate's reason", async () => {
  const { gate } = scriptedGate([], "source-off");
  const convo = conversation();
  const deliver = createTaskCardDeliver({
    reachOut: gate,
    withConversation: convo.withConversation,
    broadcast: () => assert.fail("must not broadcast"),
    transports: { push: () => assert.fail("must not push") },
  });
  assert.deepEqual(await deliver(notice()), { delivered: false, reason: "source-off" });
  assert.equal(convo.history.length, 0);
});

test("allowed but the card could not be stored: throws (the outbox retries) and does NOT push", async () => {
  const { gate } = scriptedGate(["inapp", "push"]);
  const convo = conversation({ failAppend: true });
  const deliver = createTaskCardDeliver({
    reachOut: gate,
    withConversation: convo.withConversation,
    broadcast: () => assert.fail("must not broadcast a card that was not stored"),
    transports: { push: () => assert.fail("no card, no push") },
  });
  await assert.rejects(deliver(notice()), /disk full/);
});

test("a failing note or push transport does not undo a stored card", async () => {
  const { gate } = scriptedGate(["inapp", "push"]);
  const convo = conversation();
  const deliver = createTaskCardDeliver({
    reachOut: gate,
    withConversation: convo.withConversation,
    broadcast: () => {},
    transports: {
      inapp: () => {
        throw new Error("sse down");
      },
      push: () => {
        throw new Error("ntfy down");
      },
    },
  });
  assert.deepEqual(await deliver(notice()), { delivered: true });
  assert.equal(convo.history.length, 1);
});

// ── with the real gate ──

let home: string;
let previousHome: string | undefined;
before(() => {
  previousHome = process.env.LISA_HOME;
});
after(() => {
  if (previousHome === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = previousHome;
});
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-task-delivery-"));
  process.env.LISA_HOME = home;
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** The production wiring, minus the HTTP server: real gate, real generic transports. */
function realWiring(now: Date) {
  const convo = conversation();
  const events: Array<Record<string, unknown>> = [];
  const pushed: PushEvent[] = [];
  const deferQueue = new DeferQueue();
  const reachOut = makeServerReachOut({
    pushBridge: { hasSubscribers: () => true },
    now: () => now,
    deferQueue,
  });
  const deliver = createTaskCardDeliver({
    reachOut,
    withConversation: convo.withConversation,
    broadcast: (e) => events.push(e),
    transports: createReachOutTransports({
      inapp: { emit: (e) => void events.push(e) },
      push: { notify: (e) => void pushed.push(e) },
    }),
  });
  return { deliver, convo, events, pushed, deferQueue };
}

const NOON = new Date("2026-10-02T12:00:00");

const decisions = (): LedgerNoticeEntry[] =>
  readLedger(home).filter((e): e is LedgerNoticeEntry => e.type === "notice");

test("default settings: a task result is delivered in-app and pushed, and lands in the reach-out ledger", async () => {
  const w = realWiring(NOON);
  assert.deepEqual(await w.deliver(notice()), { delivered: true });
  assert.equal(w.convo.history.length, 1);
  assert.deepEqual(
    w.events.map((e) => e.type),
    ["task_result", "idle_message"],
  );
  assert.equal(w.events[1]!.source, "task");
  assert.equal(w.events[1]!.reachOutId, w.events[0]!.reachOutId);
  assert.equal(w.pushed.length, 1);
  assert.equal(w.pushed[0]!.title, "Lisa — Morning brief");
  assert.equal(w.pushed[0]!.pref, "done");

  const ledger = decisions();
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]!.source, "task");
  assert.equal(ledger[0]!.kind, "task_result");
  assert.equal(ledger[0]!.reason, "solicited");
  assert.equal(ledger[0]!.solicited, true);
  assert.equal(ledger[0]!.budget, false, "the user's own task spends no unsolicited budget");
});

test("a watcher hit goes out as source `watcher`, high priority", async () => {
  const w = realWiring(NOON);
  await w.deliver(notice({ id: "r_0123456789abcdef-watch-hit", kind: "watch_hit", priority: "high" }));
  assert.equal(w.pushed[0]!.priority, "high");
  assert.equal(decisions()[0]!.source, "watcher");
});

test("the user switched task notifications off: nothing is stored or pushed; the outbox marks it suppressed", async () => {
  const settings = defaultReachOutSettings();
  settings.sources.task = false;
  await saveReachOutSettings(settings, home);
  const w = realWiring(NOON);
  await enqueueNotice(notice());
  assert.deepEqual(await drainOutbox(w.deliver), { delivered: 0, suppressed: 1, deferred: 0, failed: 0 });
  assert.equal(w.convo.history.length, 0);
  assert.equal(w.pushed.length, 0);
  const [entry] = await listOutbox();
  assert.equal(entry!.state, "suppressed");
  assert.equal(entry!.reason, "source-off");
});

test("quiet hours: the card is stored now, the push is held by the gate — not sent, not lost", async () => {
  const settings = defaultReachOutSettings();
  settings.quietHours = { ...settings.quietHours, enabled: true, start: "22:00", end: "07:00" };
  await saveReachOutSettings(settings, home);
  const w = realWiring(new Date("2026-10-02T23:30:00"));
  try {
    assert.deepEqual(await w.deliver(notice()), { delivered: true });
    assert.equal(w.convo.history.length, 1);
    assert.equal(w.pushed.length, 0, "no push during quiet hours");
    const entry = decisions()[0]!;
    assert.equal(entry.reason, "quiet-hours");
    assert.deepEqual(entry.deferred, ["push"]);
    assert.equal(w.deferQueue.size(), 1, "queued for the end of quiet hours");
  } finally {
    w.deferQueue.stop();
  }
});

test("dial off: in-app only", async () => {
  const settings = defaultReachOutSettings();
  settings.dial = "off";
  await saveReachOutSettings(settings, home);
  const w = realWiring(NOON);
  assert.deepEqual(await w.deliver(notice()), { delivered: true });
  assert.equal(w.convo.history.length, 1);
  assert.equal(w.pushed.length, 0);
});
