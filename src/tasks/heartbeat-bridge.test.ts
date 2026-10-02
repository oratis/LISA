import { test, before, after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Provider } from "../providers/types.js";
import { runTasksFromHeartbeat } from "./heartbeat-bridge.js";
import { heartbeatFile, heartbeatTaskId } from "./heartbeat-migration.js";
import {
  disableTask,
  enableTask,
  nextRunAfter,
  restingState,
  watchIntervalMs,
} from "./lifecycle.js";
import { listOutbox } from "./outbox.js";
import { createTask, getTask, listTasks } from "./store.js";
import type { Task } from "./types.js";

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
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-hb-bridge-"));
  process.env.LISA_HOME = home;
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function provider(reply: (prompt: string) => string): { provider: Provider; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    provider: {
      name: "fake",
      async runTurn(o) {
        const prompt = JSON.stringify(o.messages[0]);
        prompts.push(prompt);
        return {
          content: [{ type: "text", text: reply(prompt) } as never],
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    },
  };
}

const base = { tools: [], cwd: os.tmpdir(), model: "claude-test", log: () => {} };

test("a heartbeat tick migrates heartbeat.json and runs the chores that are due — once", async () => {
  fs.writeFileSync(
    heartbeatFile(),
    JSON.stringify({
      tasks: [
        { name: "disk check", prompt: "Check free disk space." },
        { name: "quiet one", prompt: "Say nothing." },
        { name: "later", prompt: "Not yet.", schedule: "every:6h" },
        { name: "off", prompt: "Never.", enabled: false },
      ],
    }),
  );
  const fake = provider((p) => (p.includes("Say nothing") ? "(no update)" : "Disk is 91% full."));
  const runnerOptions = { provider: fake.provider, unattendedAllowed: () => true };

  const results = await runTasksFromHeartbeat({
    ...base,
    signal: new AbortController().signal,
    runnerOptions,
  });
  assert.deepEqual(
    results.sort((a, b) => a.task.localeCompare(b.task)),
    [
      { task: "task:disk check", output: "Disk is 91% full.", silent: false },
      { task: "task:quiet one", output: "(no update)", silent: true },
    ],
  );
  assert.equal(fake.prompts.length, 2, "the scheduled-later and the disabled chore did not run");
  assert.deepEqual(JSON.parse(fs.readFileSync(heartbeatFile(), "utf8")).tasks, []);
  assert.equal((await listTasks()).length, 4);

  // The result is waiting in the outbox for a process that can deliver it;
  // the quiet run produced no notice at all.
  const outbox = await listOutbox();
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0]!.state, "pending");
  assert.equal(outbox[0]!.notice.summary, "Disk is 91% full.");

  // The very next tick has nothing due.
  const again = await runTasksFromHeartbeat({
    ...base,
    signal: new AbortController().signal,
    runnerOptions,
  });
  assert.deepEqual(again, []);
  assert.equal(fake.prompts.length, 2);
});

test("`lisa heartbeat run <name>` runs just that task, due or not", async () => {
  fs.writeFileSync(
    heartbeatFile(),
    JSON.stringify({
      tasks: [{ name: "later", prompt: "Weekly thing.", schedule: "weekly:mon@09:00" }],
    }),
  );
  const fake = provider(() => "Done.");
  const results = await runTasksFromHeartbeat({
    ...base,
    signal: new AbortController().signal,
    taskFilter: "later",
    runnerOptions: { provider: fake.provider },
  });
  assert.deepEqual(results, [{ task: "task:later", output: "Done.", silent: false }]);
  assert.equal(
    (await getTask(heartbeatTaskId("later")))!.state,
    "scheduled",
    "still on its schedule",
  );

  // A filter that names one of Lisa's own heartbeat tasks is not ours to run.
  const none = await runTasksFromHeartbeat({
    ...base,
    signal: new AbortController().signal,
    taskFilter: "desire:learn-rust",
    runnerOptions: { provider: fake.provider },
  });
  assert.deepEqual(none, []);
  assert.equal(fake.prompts.length, 1);
});

test("an every: routine driven only by 30-minute wake-ups runs on every wake-up, not every other", async () => {
  const start = Date.parse("2026-10-02T08:00:00Z");
  let clock = start;
  const task = await createTask(
    {
      kind: "routine",
      title: "half-hourly",
      instruction: "Check.",
      origin: { kind: "api" },
      schedule: { expr: "every:30m" },
      enabled: true,
      state: "scheduled",
      nextRunAt: start,
    },
    start,
  );
  const fake = provider(() => "ok");
  for (let wake = 0; wake < 4; wake++) {
    await runTasksFromHeartbeat({
      ...base,
      signal: new AbortController().signal,
      runnerOptions: {
        provider: fake.provider,
        unattendedAllowed: () => true,
        // Each run "takes" 40 s, so finish + 30 min lands AFTER the next wake-up.
        now: () => (clock += 10_000),
      },
    });
    clock = start + (wake + 1) * 30 * 60_000;
  }
  assert.equal(fake.prompts.length, 4);
  assert.equal(
    (await getTask(task.id))!.nextRunAt,
    start + 4 * 30 * 60_000,
    "the phase did not drift",
  );
});

// ── lifecycle (pure) ──

function fakeTask(over: Partial<Task>): Task {
  return {
    id: "t_0123456789ab",
    version: 1,
    owner: null,
    kind: "routine",
    title: "t",
    instruction: "i",
    origin: { kind: "api" },
    host: "any",
    budget: { tokens: 1, wallclockMs: 1, maxToolCalls: 1 },
    notify: "always",
    state: "draft",
    enabled: false,
    createdDisabled: true,
    createdAt: 0,
    updatedAt: 0,
    authFailureCount: 0,
    runs: [],
    ...over,
  };
}

test("an interval keeps its phase, skips missed slots, and a manual run does not move it", () => {
  const H = 3_600_000;
  const t = fakeTask({ schedule: { expr: "every:1h" }, nextRunAt: 10 * H });
  assert.equal(
    nextRunAfter(t, 10 * H + 5000),
    11 * H,
    "counted from the slot, not from the finish",
  );
  assert.equal(nextRunAfter(t, 13 * H + 1), 14 * H, "three missed slots are skipped, not replayed");
  assert.equal(nextRunAfter(t, 9 * H), 10 * H, "not due yet: unchanged");
  assert.equal(nextRunAfter(fakeTask({ schedule: { expr: "every:1h" } }), 10 * H), 11 * H);
  assert.equal(nextRunAfter(fakeTask({}), 0), undefined);
});

test("enable / disable / resting state", () => {
  const now = Date.parse("2026-10-02T08:00:00Z");
  const routine = fakeTask({ schedule: { expr: "daily:09:00", tz: "UTC" } });
  assert.equal(restingState(routine), "draft");
  enableTask(routine, now);
  assert.equal(routine.state, "scheduled");
  assert.equal(routine.enabledAt, now);
  assert.equal(new Date(routine.nextRunAt!).toISOString(), "2026-10-02T09:00:00.000Z");
  disableTask(routine);
  assert.equal(routine.state, "paused");
  assert.equal(routine.nextRunAt, undefined);
  assert.equal(restingState(routine), "paused", "once enabled, never a draft again");

  const adhoc = fakeTask({ kind: "oneoff" });
  enableTask(adhoc, now);
  assert.equal(adhoc.state, "queued", "no schedule: runs once, now");
  assert.equal(adhoc.nextRunAt, now);

  const inFlight = fakeTask({
    schedule: { expr: "every:1h" },
    activeRunId: "r_0123456789abcdef",
    state: "running",
  });
  enableTask(inFlight, now);
  assert.equal(inFlight.state, "running", "a run in flight is not disturbed");
  disableTask(inFlight);
  assert.equal(inFlight.state, "running");
  assert.equal(inFlight.enabled, false);
});

test("a failing watcher's poll interval backs off, capped", () => {
  const w = fakeTask({
    kind: "watcher",
    trigger: { kind: "rss", url: "https://example.com/f", every: "every:10m" },
  });
  assert.equal(watchIntervalMs(w), 10 * 60_000);
  assert.equal(watchIntervalMs(w, true), 30 * 60_000, "the hosted floor");
  assert.equal(nextRunAfter(w, 0), 10 * 60_000);
  assert.equal(nextRunAfter({ ...w, watch: { failures: 2 } }, 0), 40 * 60_000);
  assert.equal(nextRunAfter({ ...w, watch: { failures: 20 } }, 0), 6 * 3_600_000);
});
