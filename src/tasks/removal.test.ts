import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { homeScope } from "../paths.js";
import type { Provider, ProviderResult } from "../providers/types.js";
import type { ToolDefinition } from "../types.js";
import { createTaskHost } from "../web/tasks-host.js";
import { taskLeaseHeld } from "./lease.js";
import { enqueueNotice } from "./outbox.js";
import { removeTask } from "./removal.js";
import { TaskRunner, type TaskRunnerOptions } from "./runner.js";
import {
  appendRunMessage,
  checkpointRun,
  createRun,
  createTask,
  deleteTask,
  getTask,
  listRuns,
  TaskGoneError,
  tasksDir,
  updateTask,
} from "./store.js";

const NOW = Date.parse("2026-10-02T08:00:00Z");

/**
 * Delete a directory the way a test means it: all at once. A recursive rm is
 * not atomic — renewals still running would see the lease file gone while its
 * directory still exists, or write into it mid-removal (ENOTEMPTY). Moving
 * the directory away first makes every path under it vanish in one step.
 */
async function vanish(dir: string): Promise<void> {
  const away = `${dir}.gone-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await fsp.rename(dir, away);
  await fsp.rm(away, { recursive: true, force: true, maxRetries: 10 });
}

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "lisa-tasks-removal-"));
  try {
    return await homeScope.run(home, () => fn(home));
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(path.relative(dir, p));
    }
  };
  await walk(dir);
  return out;
}

const dueRoutine = () =>
  createTask(
    {
      kind: "routine",
      title: "Morning brief",
      instruction: "Summarise.",
      origin: { kind: "api" },
      schedule: { expr: "daily:08:00", tz: "UTC" },
      enabled: true,
      state: "scheduled",
      nextRunAt: NOW,
    },
    NOW - 1000,
  );

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const toolUse = (name: string): ProviderResult => ({
  content: [{ type: "tool_use", id: "tu_1", name, input: {} } as Anthropic.ContentBlock],
  stopReason: "tool_use",
  usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
});
const say = (text: string): ProviderResult => ({
  content: [{ type: "text", text } as Anthropic.ContentBlock],
  stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
});

/** A run that blocks inside a `read` tool call until released. */
function blockedRun(over: Partial<TaskRunnerOptions> = {}) {
  const gate = deferred();
  const inTool = deferred();
  let modelCalls = 0;
  const provider: Provider = {
    name: "fake",
    async runTurn() {
      return ++modelCalls === 1 ? toolUse("read") : say("private summary of the user's data");
    },
  };
  const read: ToolDefinition = {
    name: "read",
    description: "read",
    inputSchema: { type: "object" },
    execute: async (_input, ctx) => {
      inTool.resolve();
      await Promise.race([
        gate.promise,
        new Promise((_, reject) =>
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
        ),
      ]);
      return "user's private file contents";
    },
  };
  const runner = new TaskRunner({
    tools: [read],
    model: "m",
    cwd: os.tmpdir(),
    provider,
    unattendedAllowed: () => true,
    log: () => {},
    now: () => NOW,
    ...over,
  });
  return { runner, gate, inTool, modelCalls: () => modelCalls };
}

// ── the store never puts a deleted task or home back ──

test("writes for a deleted task fail with TaskGoneError and create nothing", async () => {
  await withHome(async (home) => {
    const task = await dueRoutine();
    const run = await createRun(task.id);
    assert.equal(await deleteTask(task.id), true);
    const before = (await filesUnder(home)).sort();

    await assert.rejects(
      appendRunMessage(task.id, run.id, { role: "user", content: "x" }),
      TaskGoneError,
    );
    await assert.rejects(checkpointRun(run), TaskGoneError);
    await assert.rejects(createRun(task.id), TaskGoneError);
    assert.equal(await updateTask(task.id, () => {}), null);
    assert.equal(await deleteTask(task.id), false);
    assert.deepEqual((await filesUnder(home)).sort(), before);
    await assert.rejects(fsp.stat(path.join(tasksDir(), "runs", task.id)), /ENOENT/);
  });
});

test("writes under a deleted home fail and do not re-create the home", async () => {
  await withHome(async (home) => {
    const task = await dueRoutine();
    const run = await createRun(task.id);
    await fsp.rm(home, { recursive: true, force: true });

    await assert.rejects(checkpointRun(run), TaskGoneError);
    await assert.rejects(createRun(task.id), TaskGoneError);
    assert.equal(await updateTask(task.id, () => {}), null);
    await assert.rejects(
      enqueueNotice({
        id: `${run.id}-task-result`,
        uid: null,
        taskId: task.id,
        runId: run.id,
        title: "t",
        summary: "s",
        status: "succeeded",
        priority: "normal",
        kind: "task_result",
      }),
      TaskGoneError,
    );
    await assert.rejects(fsp.stat(home), /ENOENT/);
  });
});

// ── a run in flight ──

test("a run in flight when its home is deleted re-creates nothing (reviewer probe t8c)", async () => {
  await withHome(async (home) => {
    await dueRoutine();
    const { runner, gate, inTool, modelCalls } = blockedRun();
    await runner.tick();
    await inTool.promise;
    await fsp.rm(home, { recursive: true, force: true }); // what DELETE /api/account does
    gate.resolve();
    await runner.drain();
    assert.deepEqual(await filesUnder(home), []);
    await assert.rejects(fsp.stat(home), /ENOENT/);
    assert.equal(modelCalls(), 1, "and it stopped: no further model call");
  });
});

test("lease renewals after the home was deleted re-create nothing; the run stops as removed (reviewer probe m3-renew-home)", async () => {
  await withHome(async (home) => {
    await dueRoutine();
    const logs: string[] = [];
    const { runner, gate, inTool, modelCalls } = blockedRun({
      leaseRenewEveryMs: 20,
      log: (m) => logs.push(m),
    });
    await runner.tick();
    await inTool.promise;
    await vanish(home);
    await new Promise((r) => setTimeout(r, 150)); // several renewals fall due meanwhile
    await assert.rejects(fsp.stat(home), /ENOENT/, "no renewal brought the home back");
    gate.resolve();
    await runner.drain();
    await assert.rejects(fsp.stat(home), /ENOENT/, "nor did the release");
    assert.equal(modelCalls(), 1);
    assert.ok(
      logs.some((l) => l.includes("removed while running")),
      `stopped as a removed task: ${logs.join(" | ")}`,
    );
  });
});

test("a run in flight when its task is deleted stops and leaves nothing of the task behind", async () => {
  await withHome(async (home) => {
    const task = await dueRoutine();
    const { runner, gate, inTool, modelCalls } = blockedRun();
    await runner.tick();
    await inTool.promise;
    assert.equal(await deleteTask(task.id), true); // a blunt delete, no cancel, no wait
    gate.resolve();
    await runner.drain();
    assert.equal(modelCalls(), 1);
    const left = await filesUnder(home);
    assert.ok(
      !left.some((f) => f.includes(task.id) && !f.includes(".lock") && !f.includes(".lease")),
      left.join(", "),
    );
    assert.equal(await getTask(task.id), null);
  });
});

test("removeTask cancels a run in this process, waits for it to let go, then deletes", async () => {
  await withHome(async (home) => {
    const task = await dueRoutine();
    const { runner, inTool, modelCalls } = blockedRun();
    await runner.tick();
    await inTool.promise;
    assert.equal(await taskLeaseHeld(task.id), true);

    const result = await removeTask(task.id, { runner });
    assert.deepEqual(result, { removed: true, waited: true, stillRunning: false });
    assert.equal(await taskLeaseHeld(task.id), false);
    await runner.drain();
    assert.equal(modelCalls(), 1);
    assert.equal(await getTask(task.id), null);
    const left = await filesUnder(home);
    assert.ok(
      !left.some((f) => f.endsWith(".jsonl") || f === path.join("tasks", `${task.id}.json`)),
      left.join(", "),
    );
    assert.deepEqual(await removeTask(task.id, { runner }), {
      removed: false,
      waited: false,
      stillRunning: false,
    });
  });
});

test("removeTask without a runner flags the run (another process owns it) and gives up waiting after the deadline", async () => {
  await withHome(async () => {
    const task = await dueRoutine();
    const { runner, gate, inTool } = blockedRun();
    await runner.tick();
    await inTool.promise;
    // Seen from "another process": no runner handle. This tool ignores the
    // flag until it returns, so the wait times out and the task is removed anyway.
    const stuck = removeTask(task.id, { waitMs: 2000 });
    try {
      const deadline = Date.now() + 1500;
      while (!(await getTask(task.id))?.cancelRequestedAt && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(typeof (await getTask(task.id))?.cancelRequestedAt, "number");
      assert.deepEqual(await stuck, { removed: true, waited: true, stillRunning: true });
      assert.equal(await getTask(task.id), null);
    } finally {
      gate.resolve();
      await stuck;
      await runner.drain();
    }
  });
});

// ── account deletion ──

test("a run is registered as account work: deletion can stop it, wait for it, and refuse new ones", async () => {
  await withHome(async () => {
    const task = await dueRoutine();
    const stops: Array<() => void> = [];
    let finished = 0;
    let deleting = false;
    const { runner, inTool } = blockedRun({
      trackRun: (stop) => {
        if (deleting) return null;
        stops.push(stop);
        return () => void finished++;
      },
    });
    await runner.tick();
    await inTool.promise;
    assert.equal(stops.length, 1);
    assert.equal(finished, 0);

    // What account deletion does: stop every registered piece of work, await it.
    deleting = true;
    stops[0]!();
    await runner.drain();
    assert.equal(finished, 1, "the work is reported done only after the run's last write");
    const t = (await getTask(task.id))!;
    assert.equal((await listRuns(t))[0]!.state, "cancelled");
    assert.equal(t.activeRunId, undefined);

    // While the account is being deleted nothing new starts.
    await updateTask(task.id, (x) => {
      x.nextRunAt = NOW;
      x.state = "scheduled";
    });
    assert.deepEqual((await runner.tick()).started, []);
    assert.equal(
      await taskLeaseHeld(task.id),
      false,
      "and the lease taken for the refused run was given back",
    );
  });
});

test("the web host registers hosted runs with the server's account work and can forget a tenant", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "lisa-tasks-host-"));
  const previous = process.env.LISA_HOME;
  process.env.LISA_HOME = root;
  const uid = "u1removal";
  const tracked: string[] = [];
  let done = 0;
  const host = createTaskHost({
    cloud: true,
    cloudEnabled: true,
    profile: "cloud-chat",
    tools: [],
    model: "m",
    cwd: os.tmpdir(),
    broadcast: () => {},
    reachOut: async () => ({ id: "ro", deliver: false, channels: [], reason: "no-channel" }),
    withConversation: (fn) => fn({ history: [], append: async () => {} }),
    modelGateFor: () => ({
      admit: async () => ({ ok: true, settle: async () => {}, release: async () => {} }),
    }),
    trackWork: (who) => {
      tracked.push(who);
      return () => void done++;
    },
  });
  try {
    const { homeForUid } = await import("../paths.js");
    await fsp.mkdir(homeForUid(uid), { recursive: true });
    await homeScope.run(homeForUid(uid), async () => {
      const task = await dueRoutine();
      const runner = host.runnerFor(uid)!;
      assert.ok(runner);
      // No provider is configured for model "m": the run fails fast, which is all this needs.
      await runner.runNow(task.id);
      await runner.drain();
      assert.deepEqual(tracked, [uid]);
      assert.equal(done, 1);
      await host.forgetTenant(uid);
      assert.notEqual(
        host.runnerFor(uid),
        runner,
        "a forgotten tenant gets a fresh runner if it ever returns",
      );
    });
  } finally {
    await host.stop();
    if (previous === undefined) delete process.env.LISA_HOME;
    else process.env.LISA_HOME = previous;
    await fsp.rm(root, { recursive: true, force: true });
  }
});
