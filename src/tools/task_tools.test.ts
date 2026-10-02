import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { homeScope } from "../paths.js";
import { TASK_TOOL_NAMES } from "../tasks/policy.js";
import type { TaskEngineEvent } from "../tasks/runner.js";
import { createRun, createTask, getTask, listTasks, updateTask } from "../tasks/store.js";
import { enableTask } from "../tasks/lifecycle.js";
import { setTaskEventSink } from "../tasks/wiring.js";
import type { ToolContext } from "../types.js";
import {
  AUTONOMOUS_BLOCKED_TOOL_NAMES,
  REMOTE_BLOCKED_TOOL_NAMES,
  autonomousSubset,
  buildToolRegistry,
  cloudSafeSubset,
  remoteSafeSubset,
} from "./registry.js";
import { taskCancelTool } from "./task_cancel.js";
import { taskCreateTool } from "./task_create.js";
import { CLOUD_TASK_TOOL_NAMES, TASK_ENGINE_TOOL_NAMES } from "./task_index.js";
import { taskListTool } from "./task_list.js";
import { taskUpdateTool } from "./task_update.js";
import { watchCreateTool } from "./watch_create.js";

const ctx: ToolContext = { cwd: os.tmpdir(), signal: new AbortController().signal, log: () => {} };

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "lisa-task-tools-"));
  try {
    return await homeScope.run(home, fn);
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
}

describe("task tools — where they are offered", () => {
  const all = buildToolRegistry();
  const names = (tools: Array<{ name: string }>) => new Set(tools.map((t) => t.name));

  test("all five are registered for interactive chat", () => {
    for (const name of TASK_ENGINE_TOOL_NAMES) assert.ok(names(all).has(name), name);
    assert.deepEqual([...TASK_ENGINE_TOOL_NAMES].sort(), [...TASK_TOOL_NAMES].sort());
  });

  test("none reach unattended runs or remote channels", () => {
    const autonomous = names(autonomousSubset(all));
    const remote = names(remoteSafeSubset(all));
    for (const name of TASK_ENGINE_TOOL_NAMES) {
      assert.ok(AUTONOMOUS_BLOCKED_TOOL_NAMES.has(name), name);
      assert.ok(REMOTE_BLOCKED_TOOL_NAMES.has(name), name);
      assert.equal(autonomous.has(name), false, name);
      assert.equal(remote.has(name), false, name);
    }
  });

  test("the hosted edition offers them only with LISA_CLOUD_TASKS=1, and never watch_create", () => {
    const previous = process.env.LISA_CLOUD_TASKS;
    try {
      delete process.env.LISA_CLOUD_TASKS;
      const off = names(cloudSafeSubset(all));
      for (const name of TASK_ENGINE_TOOL_NAMES) assert.equal(off.has(name), false, name);

      process.env.LISA_CLOUD_TASKS = "1";
      const on = names(cloudSafeSubset(all));
      for (const name of CLOUD_TASK_TOOL_NAMES) assert.equal(on.has(name), true, name);
      assert.equal(on.has("watch_create"), false);
      assert.equal(on.has("bash"), false, "the flag widens nothing else");
    } finally {
      if (previous === undefined) delete process.env.LISA_CLOUD_TASKS;
      else process.env.LISA_CLOUD_TASKS = previous;
    }
  });

  test("no tool schema has a way to enable a task", () => {
    for (const tool of [taskCreateTool, taskUpdateTool, watchCreateTool, taskCancelTool]) {
      const props = Object.keys((tool.inputSchema.properties ?? {}));
      assert.ok(!props.some((p) => /enable/i.test(p)), `${tool.name}: ${props.join(",")}`);
      assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    }
  });

  test("smuggling enabled/state into the input changes nothing: execute ignores unknown fields", async () => {
    await withHome(async () => {
      const smuggled = { title: "x", instruction: "y", schedule: "daily:08:00", enabled: true, state: "scheduled" };
      await taskCreateTool.execute(smuggled, ctx);
      const [task] = await listTasks();
      assert.equal(task!.enabled, false);
      assert.equal(task!.state, "draft");
      await taskUpdateTool.execute({ id: task!.id, title: "z", enabled: true } as never, ctx);
      assert.equal((await getTask(task!.id))!.enabled, false);
      await watchCreateTool.execute(
        { title: "w", source: "rss", url: "https://example.com/feed", enabled: true } as never,
        ctx,
      );
      assert.ok((await listTasks()).every((t) => !t.enabled));
    });
  });
});

describe("task_create / watch_create", () => {
  test("creates a disabled draft and returns a card that says so", async () => {
    await withHome(async () => {
      const events: TaskEngineEvent[] = [];
      setTaskEventSink((e) => events.push(e));
      try {
        const card = await taskCreateTool.execute(
          {
            title: "Morning brief",
            instruction: "Summarise important mail and today's calendar risks.",
            schedule: "weekdays:08:00",
            timezone: "Europe/Berlin",
            notify: "silent_on_noop",
            tools: ["web_fetch"],
            max_minutes: 5,
          },
          ctx,
        );
        const [task] = await listTasks();
        assert.ok(task);
        assert.equal(task.enabled, false);
        assert.equal(task.state, "draft");
        assert.equal(task.createdDisabled, true);
        assert.equal(task.kind, "routine");
        assert.deepEqual(task.origin, { kind: "chat" });
        assert.deepEqual(task.schedule, { expr: "weekdays:08:00", tz: "Europe/Berlin" });
        assert.deepEqual(task.envelope, { tools: ["web_fetch"] });
        assert.equal(task.budget.wallclockMs, 5 * 60_000);
        assert.equal(task.nextRunAt, undefined, "a draft has no next run");
        assert.match(card, /It is OFF/);
        assert.match(card, new RegExp(`lisa tasks enable ${task.id}`));
        assert.match(card, /You cannot enable it yourself/);
        assert.deepEqual(
          events.map((e) => e.type),
          ["task_updated"],
        );
      } finally {
        setTaskEventSink(undefined);
      }
    });
  });

  test("kind defaults from the schedule; bad input is refused without writing anything", async () => {
    await withHome(async () => {
      await taskCreateTool.execute({ title: "Once", instruction: "Do it once." }, ctx);
      await taskCreateTool.execute(
        { title: "At", instruction: "Remind me.", kind: "oneoff", schedule: "at:2030-01-01T09:00:00Z" },
        ctx,
      );
      assert.deepEqual(
        (await listTasks()).map((t) => t.kind),
        ["oneoff", "oneoff"],
      );
      for (const [input, pattern] of [
        [{ title: "x", instruction: "y", schedule: "every:1m" }, /at least 5 minutes/],
        [{ title: "x", instruction: "y", schedule: "whenever" }, /unrecognised schedule/],
        [{ title: "x", instruction: "y", kind: "routine" as const }, /needs a schedule/],
        [{ title: " ", instruction: "y" }, /title is required/],
        [{ title: "x", instruction: "y", max_tokens: 99_999_999 }, /budget.tokens/],
      ] as const) {
        assert.match(await taskCreateTool.execute(input, ctx), pattern);
      }
      assert.equal((await listTasks()).length, 2);
    });
  });

  test("watch_create drafts a disabled watcher; a hit notifies unless told to run", async () => {
    await withHome(async () => {
      const card = await watchCreateTool.execute(
        {
          title: "Campsite opening",
          source: "web",
          url: "https://example.com/sites",
          mode: "appears",
          contains: "Available",
          every: "every:10m",
        },
        ctx,
      );
      const [task] = await listTasks();
      assert.ok(task);
      assert.equal(task.kind, "watcher");
      assert.equal(task.enabled, false);
      assert.equal(task.notify, "on_hit");
      assert.deepEqual(task.trigger, {
        kind: "web",
        url: "https://example.com/sites",
        mode: "appears",
        contains: "Available",
        every: "every:10m",
      });
      assert.match(card, /on hit: notify/);
      assert.match(card, /It is OFF/);

      assert.match(
        await watchCreateTool.execute({ title: "x", source: "web", url: "https://e.com", on_hit: "run" }, ctx),
        /needs an instruction/,
      );
      assert.match(
        await watchCreateTool.execute({ title: "x", source: "web", url: "file:///etc/passwd" }, ctx),
        /http\(s\)/,
      );
      assert.match(await watchCreateTool.execute({ title: "x", source: "mail" }, ctx), /needs trigger.from/);
      assert.equal((await listTasks()).length, 1);
    });
  });
});

describe("task_list / task_update / task_cancel", () => {
  test("task_list shows state, and one task's recent runs", async () => {
    await withHome(async () => {
      assert.equal(await taskListTool.execute({}, ctx), "(no tasks)");
      await taskCreateTool.execute({ title: "Brief", instruction: "Summarise.", schedule: "daily:08:00" }, ctx);
      const [task] = await listTasks();
      const listing = await taskListTool.execute({}, ctx);
      assert.match(listing, /1 task\(s\)/);
      assert.match(listing, /draft, OFF/);
      const detail = await taskListTool.execute({ id: task!.id }, ctx);
      assert.match(detail, /instruction: Summarise\./);
      assert.match(detail, /no runs yet/);
      assert.match(await taskListTool.execute({ id: "t_doesnotexist" }, ctx), /no task with id/);
    });
  });

  test("an edit through the tool switches an enabled task off", async () => {
    await withHome(async () => {
      const task = await createTask({
        kind: "routine",
        title: "Brief",
        instruction: "Summarise.",
        origin: { kind: "api" },
        schedule: { expr: "daily:08:00" },
      });
      await updateTask(task.id, (t) => enableTask(t, Date.now()));
      assert.equal((await getTask(task.id))!.enabled, true);

      const card = await taskUpdateTool.execute(
        { id: task.id, instruction: "Summarise, then email everyone I know.", schedule: "every:5m" },
        ctx,
      );
      const after = (await getTask(task.id))!;
      assert.equal(after.enabled, false, "the model cannot change what runs unattended and leave it on");
      assert.equal(after.state, "paused");
      assert.equal(after.nextRunAt, undefined);
      assert.equal(after.instruction, "Summarise, then email everyone I know.");
      assert.match(card, /has been switched off/);

      assert.match(await taskUpdateTool.execute({ id: task.id, schedule: "every:1m" }, ctx), /at least 5 minutes/);
      assert.equal((await getTask(task.id))!.schedule!.expr, "every:5m", "a rejected edit changes nothing");
      assert.match(await taskUpdateTool.execute({ id: task.id }, ctx), /nothing to change/);
      assert.match(await taskUpdateTool.execute({ id: "t_doesnotexist", pause: true }, ctx), /no task with id/);
    });
  });

  test("pause switches a task off without editing it; a never-enabled task stays a draft", async () => {
    await withHome(async () => {
      const task = await createTask({
        kind: "routine",
        title: "Brief",
        instruction: "Summarise.",
        origin: { kind: "api" },
        schedule: { expr: "daily:08:00" },
      });
      await updateTask(task.id, (t) => enableTask(t, Date.now()));
      assert.match(await taskUpdateTool.execute({ id: task.id, pause: true }, ctx), /Paused/);
      assert.equal((await getTask(task.id))!.state, "paused");

      await taskCreateTool.execute({ title: "Draft", instruction: "x", schedule: "daily:09:00" }, ctx);
      const draft = (await listTasks()).find((t) => t.title === "Draft")!;
      await taskUpdateTool.execute({ id: draft.id, title: "Draft 2" }, ctx);
      assert.equal((await getTask(draft.id))!.state, "draft");
    });
  });

  test("task_cancel flags a running task, un-queues a queued one, and says so when idle", async () => {
    await withHome(async () => {
      const task = await createTask({
        kind: "routine",
        title: "Brief",
        instruction: "Summarise.",
        origin: { kind: "api" },
        schedule: { expr: "daily:08:00" },
        enabled: true,
      });
      assert.match(await taskCancelTool.execute({ id: task.id }, ctx), /nothing running or queued/);

      const run = await createRun(task.id);
      await updateTask(task.id, (t) => {
        t.state = "running";
        t.activeRunId = run.id;
      });
      assert.match(await taskCancelTool.execute({ id: task.id }, ctx), /next checkpoint/);
      assert.equal(typeof (await getTask(task.id))!.cancelRequestedAt, "number");

      await updateTask(task.id, (t) => {
        delete t.activeRunId;
        delete t.cancelRequestedAt;
        t.state = "queued";
        t.queued = { manual: true };
      });
      assert.match(await taskCancelTool.execute({ id: task.id }, ctx), /Removed the queued run/);
      const after = (await getTask(task.id))!;
      assert.equal(after.state, "scheduled");
      assert.equal(after.queued, undefined);
      assert.ok(after.nextRunAt! > Date.now());
    });
  });
});
