import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "../cli-args.js";
import { homeScope } from "../paths.js";
import type { Provider } from "../providers/types.js";
import { TaskRunner } from "../tasks/runner.js";
import { isEnvelopeConfirmed, taskDigest } from "../tasks/confirmation.js";
import { createTask, getTask, listTasks } from "../tasks/store.js";
import { runTaskNow, runTasksCommand } from "./tasks.js";

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "lisa-cli-tasks-"));
  try {
    return await homeScope.run(home, fn);
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

const routine = {
  kind: "routine" as const,
  title: "Morning brief",
  instruction: "Summarise what matters today.",
  origin: { kind: "chat" as const },
  schedule: { expr: "daily:08:00", tz: "UTC" },
};

function fakeProvider(text: string): Provider {
  return {
    name: "fake",
    async runTurn() {
      return {
        content: [{ type: "text", text } as never],
        stopReason: "end_turn",
        usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
}

test("`lisa tasks …` parses as a subcommand with its arguments", () => {
  const args = parseArgs(["tasks", "enable", "t_abc"]);
  assert.equal(args.subcommand, "tasks");
  assert.deepEqual(args.subargs, ["enable", "t_abc"]);
  assert.equal(parseArgs(["tasks"]).subcommand, "tasks");
  // Flags after `tasks` belong to the subcommand, not to the global parser.
  assert.deepEqual(parseArgs(["tasks", "migrate-heartbeat", "--dry-run"]).subargs, [
    "migrate-heartbeat",
    "--dry-run",
  ]);
});

test("list: empty, then one line per task", async () => {
  await withHome(async () => {
    const empty = capture();
    assert.equal(await runTasksCommand([], empty.io), 0);
    assert.match(empty.out[0]!, /no tasks/);

    const task = await createTask(routine);
    const listed = capture();
    assert.equal(await runTasksCommand(["list"], listed.io), 0);
    assert.match(listed.out[0]!, new RegExp(task.id));
    assert.match(listed.out[0]!, /draft, off/);
    assert.match(listed.out[0]!, /daily:08:00 \(UTC\)/);
  });
});

test("enable is the user's confirmation; disable turns it back off; ids may be prefixes", async () => {
  await withHome(async () => {
    const task = await createTask(routine);
    const now = Date.parse("2026-10-02T07:00:00Z");
    const enabled = capture();
    assert.equal(
      await runTasksCommand(["enable", task.id.slice(0, 6)], { ...enabled.io, now: () => now }),
      0,
    );
    const on = (await getTask(task.id))!;
    assert.equal(on.enabled, true);
    assert.equal(on.state, "scheduled");
    assert.equal(new Date(on.nextRunAt!).toISOString(), "2026-10-02T08:00:00.000Z");
    // First what it does (no envelope here: nothing to pre-approve), then that it is on.
    assert.match(enabled.out.join("\n"), /Nothing is pre-approved/);
    assert.match(enabled.out.at(-1)!, /is on — next run/);

    const disabled = capture();
    assert.equal(await runTasksCommand(["disable", task.id], disabled.io), 0);
    const off = (await getTask(task.id))!;
    assert.equal(off.enabled, false);
    assert.equal(off.state, "paused");
    assert.equal(off.nextRunAt, undefined);
  });
});

test("show prints what a confirmation would cover, and the digest that confirms it", async () => {
  await withHome(async () => {
    const task = await createTask({
      ...routine,
      envelope: { tools: ["bash"], categories: ["send"] },
    });
    const shown = capture();
    assert.equal(await runTasksCommand(["show", task.id], shown.io), 0);
    const screen = shown.out.join("\n");
    assert.match(screen, /Not confirmed — its envelope only restricts/);
    assert.match(screen, /If you confirm, these actions will run without asking:/);
    assert.match(screen, /the tool bash \(run shell commands\)/);
    assert.match(screen, /any "send" action: send messages/);
    assert.match(screen, /on any target/);
    assert.match(screen, /When: daily:08:00 \(UTC\)/);
    assert.match(screen, new RegExp(`digest ${taskDigest(task)}`));
    assert.match(screen, new RegExp(`lisa tasks enable ${task.id} --confirm ${taskDigest(task)}`));

    // A wrong digest changes nothing; --confirm belongs to enable only.
    const wrong = capture();
    assert.equal(
      await runTasksCommand(["enable", task.id, "--confirm", "0".repeat(64)], wrong.io),
      2,
    );
    assert.equal((await getTask(task.id))!.enabled, false);
    assert.equal(await runTasksCommand(["show", task.id, "--confirm", "x"], capture().io), 2);

    const ok = capture();
    assert.equal(
      await runTasksCommand([`--confirm=${taskDigest(task)}`, "enable", task.id], ok.io),
      0,
    );
    const on = (await getTask(task.id))!;
    assert.equal(on.enabled, true);
    assert.equal(isEnvelopeConfirmed(on), true);
    const again = capture();
    await runTasksCommand(["show", task.id], again.io);
    assert.match(again.out.join("\n"), /Confirmed .* \(cli\):/);
  });
});

test("show prints the instruction and recent runs; rm removes the task", async () => {
  await withHome(async () => {
    const task = await createTask(routine);
    const runner = new TaskRunner({
      tools: [],
      model: "claude-test",
      cwd: os.tmpdir(),
      provider: fakeProvider("Nothing urgent."),
      log: () => {},
    });
    const ran = capture();
    assert.equal(await runTaskNow(task.id, runner, ran.io), 0);
    assert.deepEqual(ran.out, ["Nothing urgent."]);
    assert.match(ran.err[0]!, /\[succeeded · end_turn\] 7 tokens, 0 tool calls/);

    const shown = capture();
    assert.equal(await runTasksCommand(["show", task.id], shown.io), 0);
    const text = shown.out.join("\n");
    assert.match(text, /Summarise what matters today\./);
    assert.match(text, /succeeded \(end_turn\) · 7 tokens/);
    assert.match(text, /Nothing urgent\./);

    const removed = capture();
    assert.equal(await runTasksCommand(["rm", task.id], removed.io), 0);
    assert.deepEqual(await listTasks(), []);
  });
});

test("run reports a failed run with a non-zero exit, and a busy task without running it", async () => {
  await withHome(async () => {
    const task = await createTask(routine);
    const failing: Provider = {
      name: "fake",
      async runTurn() {
        throw new Error("model unreachable");
      },
    };
    const runner = new TaskRunner({
      tools: [],
      model: "m",
      cwd: os.tmpdir(),
      provider: failing,
      log: () => {},
    });
    const failed = capture();
    assert.equal(await runTaskNow(task.id, runner, failed.io), 1);
    assert.ok(failed.err.some((l) => /model unreachable/.test(l)));

    const { updateTask, createRun } = await import("../tasks/store.js");
    const run = await createRun(task.id);
    await updateTask(task.id, (t) => {
      t.state = "running";
      t.activeRunId = run.id;
    });
    const busy = capture();
    assert.equal(await runTaskNow(task.id, runner, busy.io), 1);
    assert.match(busy.err[0]!, /already running/);
  });
});

test("unknown ids, ambiguous prefixes and unknown subcommands exit 2", async () => {
  await withHome(async () => {
    await createTask({ ...routine, id: "t_aaaa00000001" });
    await createTask({ ...routine, id: "t_aaaa00000002" });
    for (const args of [["show", "t_nope"], ["enable", "t_aaaa"], ["rm"], ["frobnicate"]]) {
      const c = capture();
      assert.equal(await runTasksCommand(args, c.io), 2, args.join(" "));
      assert.ok(c.err.length > 0);
    }
    assert.equal((await listTasks()).length, 2);
  });
});
