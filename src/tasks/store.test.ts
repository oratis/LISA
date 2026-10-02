import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { homeScope } from "../paths.js";
import {
  appendRunEvent,
  appendRunMessage,
  checkpointRun,
  createRun,
  createTask,
  deleteTask,
  getTask,
  listRuns,
  listTasks,
  loadRun,
  parseTask,
  resetRunMessages,
  tasksDir,
  updateTask,
} from "./store.js";
import { MAX_RUNS_PER_TASK, TASK_SCHEMA_VERSION } from "./types.js";

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "lisa-tasks-store-"));
  try {
    return await homeScope.run(home, () => fn(home));
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
}

const base = {
  kind: "routine" as const,
  title: "Morning brief",
  instruction: "Summarise what matters today.",
  origin: { kind: "api" as const },
};

test("createTask defaults to a disabled draft and round-trips", async () => {
  await withHome(async () => {
    const task = await createTask(base, 1000);
    assert.equal(task.enabled, false);
    assert.equal(task.state, "draft");
    assert.equal(task.createdDisabled, true);
    assert.equal(task.version, TASK_SCHEMA_VERSION);
    assert.equal(task.notify, "always");
    assert.deepEqual(await getTask(task.id), task);
    assert.deepEqual(await listTasks(), [task]);
  });
});

test("createTask refuses to overwrite an existing id", async () => {
  await withHome(async () => {
    await createTask({ ...base, id: "hb-morning-brief" });
    await assert.rejects(createTask({ ...base, id: "hb-morning-brief" }), /already exists/);
    await assert.rejects(createTask({ ...base, id: "../escape" }), /invalid task id/);
  });
});

test("updateTask is a locked read-modify-write; concurrent updates all land", async () => {
  await withHome(async () => {
    const task = await createTask(base);
    await Promise.all(
      Array.from({ length: 12 }, () =>
        updateTask(task.id, (t) => {
          t.authFailureCount += 1;
        }),
      ),
    );
    assert.equal((await getTask(task.id))!.authFailureCount, 12);
    // Returning false aborts the write; the id is not editable.
    const before = await getTask(task.id);
    await updateTask(task.id, () => false);
    assert.deepEqual(await getTask(task.id), before);
    const renamed = await updateTask(task.id, (t) => {
      t.id = "t_somethingelse";
    });
    assert.equal(renamed!.id, task.id);
    assert.equal(await updateTask("t_doesnotexist", () => {}), null);
  });
});

test("a corrupt task file is quarantined and the rest still load", async () => {
  await withHome(async () => {
    const good = await createTask(base);
    await fsp.writeFile(path.join(tasksDir(), "t_brokenjson01.json"), "{ not json");
    await fsp.writeFile(
      path.join(tasksDir(), "t_wrongshape01.json"),
      JSON.stringify({ id: "t_wrongshape01", version: 1, title: 7 }),
    );
    // A file whose body claims a different id than its name is not trusted either.
    await fsp.writeFile(path.join(tasksDir(), "t_mismatch0001.json"), JSON.stringify(good));

    const listed = await listTasks();
    assert.deepEqual(
      listed.map((t) => t.id),
      [good.id],
    );
    const names = await fsp.readdir(tasksDir());
    for (const id of ["t_brokenjson01", "t_wrongshape01", "t_mismatch0001"]) {
      assert.ok(
        names.some((n) => n.startsWith(`${id}.json.`) && n.endsWith(".corrupt")),
        `${id} quarantined`,
      );
      assert.ok(!names.includes(`${id}.json`), `${id} moved out of the way`);
    }
    // A second pass is quiet: nothing left to quarantine, nothing thrown.
    assert.equal((await listTasks()).length, 1);
    assert.equal(await getTask("t_brokenjson01"), null);
  });
});

test("a task written by a newer build is skipped but left in place", async () => {
  await withHome(async () => {
    const good = await createTask(base);
    const future = { ...good, id: "t_fromthefuture", version: TASK_SCHEMA_VERSION + 1 };
    const file = path.join(tasksDir(), "t_fromthefuture.json");
    await fsp.writeFile(file, JSON.stringify(future));
    assert.deepEqual(
      (await listTasks()).map((t) => t.id),
      [good.id],
    );
    assert.equal(JSON.parse(await fsp.readFile(file, "utf8")).version, TASK_SCHEMA_VERSION + 1);
    assert.deepEqual(parseTask(future), { ok: false, reason: "newer" });
  });
});

test("parseTask restores defaulted fields on a hand-edited file", async () => {
  await withHome(async () => {
    const good = await createTask(base);
    const { runs: _runs, authFailureCount: _a, createdDisabled: _c, ...trimmed } = good;
    const parsed = parseTask(trimmed);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.task.runs, []);
    assert.equal(parsed.task.authFailureCount, 0);
    assert.equal(parsed.task.createdDisabled, false);
  });
});

test("run log: checkpoints, messages, events and reset replay in order", async () => {
  await withHome(async () => {
    const task = await createTask(base);
    const run = await createRun(task.id, { input: "hit: price dropped" });
    assert.deepEqual((await getTask(task.id))!.runs, [run.id]);

    await appendRunMessage(task.id, run.id, { role: "user", content: "go" });
    await appendRunMessage(task.id, run.id, { role: "assistant", content: "calling a tool" });
    await appendRunEvent(task.id, run.id, { type: "tool_call", toolName: "web_fetch" });
    run.toolCalls = 1;
    run.executedDigests = { abc: "ok" };
    await checkpointRun(run);
    await resetRunMessages(task.id, run.id, 1);
    await appendRunMessage(task.id, run.id, { role: "assistant", content: "second try" });

    const loaded = await loadRun(task.id, run.id);
    assert.ok(loaded);
    assert.equal(loaded.run.toolCalls, 1);
    assert.equal(loaded.run.input, "hit: price dropped");
    assert.deepEqual(loaded.run.executedDigests, { abc: "ok" });
    assert.deepEqual(
      loaded.messages.map((m) => m.content),
      ["go", "second try"],
    );
    assert.equal(loaded.events.length, 1);
    assert.equal(loaded.events[0]!.toolName, "web_fetch");
    assert.equal((await listRuns((await getTask(task.id))!)).length, 1);
  });
});

test("a torn last line in a run log does not lose the earlier checkpoint", async () => {
  await withHome(async () => {
    const task = await createTask(base);
    const run = await createRun(task.id);
    run.toolCalls = 3;
    await checkpointRun(run);
    const file = path.join(tasksDir(), "runs", task.id, `${run.id}.jsonl`);
    await fsp.appendFile(file, '{"t":"run","at":1,"run":{"id":"' /* crash mid-append */);
    const loaded = await loadRun(task.id, run.id);
    assert.equal(loaded!.run.toolCalls, 3);
    assert.equal(await loadRun(task.id, "r_missing000000000"), null);
    assert.equal(await loadRun(task.id, "../../etc"), null);
  });
});

test("run ids are capped per task and old run logs are pruned", async () => {
  await withHome(async () => {
    const task = await createTask(base);
    const ids: string[] = [];
    for (let i = 0; i < MAX_RUNS_PER_TASK + 3; i++) ids.push((await createRun(task.id)).id);
    const stored = (await getTask(task.id))!;
    assert.equal(stored.runs.length, MAX_RUNS_PER_TASK);
    assert.deepEqual(stored.runs, ids.slice(3));
    const files = await fsp.readdir(path.join(tasksDir(), "runs", task.id));
    assert.equal(files.length, MAX_RUNS_PER_TASK);
    assert.ok(!files.includes(`${ids[0]}.jsonl`));
  });
});

test("deleteTask removes the task and its runs", async () => {
  await withHome(async () => {
    const task = await createTask(base);
    await createRun(task.id);
    assert.equal(await deleteTask(task.id), true);
    assert.equal(await getTask(task.id), null);
    await assert.rejects(fsp.stat(path.join(tasksDir(), "runs", task.id)));
    assert.equal(await deleteTask(task.id), false);
  });
});

test("stores are isolated per home scope", async () => {
  await withHome(async () => {
    const mine = await createTask(base);
    await withHome(async () => {
      assert.deepEqual(await listTasks(), []);
      assert.equal(await getTask(mine.id), null);
    });
    assert.equal((await listTasks()).length, 1);
  });
});

test("a stored schedule that cannot be used loads switched off with the reason; the file is not rewritten", async () => {
  await withHome(async () => {
    const good = await createTask({
      ...base,
      schedule: { expr: "daily:08:00", tz: "UTC" },
      enabled: true,
      state: "scheduled",
      nextRunAt: 123,
    });
    const file = path.join(tasksDir(), `${good.id}.json`);
    for (const [schedule, reason] of [
      [{ expr: "daily:08:00", tz: "Mars/Olympus" }, /time zone/],
      [{ expr: "whenever" }, /unrecognised schedule/],
    ] as const) {
      const text = JSON.stringify({ ...good, schedule });
      await fsp.writeFile(file, text);
      const loaded = (await getTask(good.id))!;
      assert.equal(loaded.enabled, false);
      assert.equal(loaded.state, "paused");
      assert.match(loaded.pausedReason!, reason);
      assert.equal(loaded.nextRunAt, undefined);
      assert.equal(await fsp.readFile(file, "utf8"), text, "reading never writes");
      assert.equal((await listTasks()).length, 1, "not quarantined either");
    }
  });
});
