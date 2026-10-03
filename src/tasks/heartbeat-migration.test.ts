import { test, before, after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runTasksCommand } from "../cli/tasks.js";
import { heartbeatRunLockPath } from "../heartbeat/config.js";
import { withFileLock } from "../soul/lock.js";
import { disableTask, pauseTask } from "./lifecycle.js";
import {
  budgetForChore,
  describeMigration,
  HEARTBEAT_LEGACY_CATEGORY,
  heartbeatFile,
  heartbeatTaskId,
  installedHeartbeatIntervalSec,
  migrateHeartbeatTasks,
  MIGRATION_WARNING,
  scheduleForChore,
  stillOnHeartbeat,
  type RawChore,
} from "./heartbeat-migration.js";
import { createTask, getTask, listTasks, updateTask } from "./store.js";

// heartbeat.json lives in the operator home, so this file drives LISA_HOME.
let home: string;
let previousHome: string | undefined;
let previousEdition: string | undefined;
const NOW = Date.parse("2026-10-02T08:00:00Z");

before(() => {
  previousHome = process.env.LISA_HOME;
  previousEdition = process.env.LISA_EDITION;
  delete process.env.LISA_EDITION;
});
after(() => {
  if (previousHome === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = previousHome;
  if (previousEdition !== undefined) process.env.LISA_EDITION = previousEdition;
});
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-hb-migrate-"));
  process.env.LISA_HOME = home;
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function writeHeartbeat(config: unknown): void {
  fs.writeFileSync(
    heartbeatFile(),
    typeof config === "string" ? config : JSON.stringify(config, null, 2),
  );
}
const readHeartbeat = () => JSON.parse(fs.readFileSync(heartbeatFile(), "utf8"));

const CONFIG = {
  budgetTokens: 250_000,
  somethingElse: { keep: "me" },
  tasks: [
    { name: "inbox triage", prompt: "Triage my inbox.", schedule: "daily:08:00" },
    { name: "disk check", prompt: "Check free disk space." },
    { name: "weekly review", prompt: "Review the week.", schedule: "0 18 * * 5", enabled: false },
  ],
};
// 30 minutes, as if the launchd job were installed with its default.
const migrate = (over: Parameters<typeof migrateHeartbeatTasks>[0] = {}) =>
  migrateHeartbeatTasks({ now: NOW, heartbeatIntervalSec: 1800, ...over });

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** The routine id of a chore (it always has one in these tests). */
const idOf = (chore: RawChore): string => heartbeatTaskId(chore)!;
const chore = (name: string): RawChore => CONFIG.tasks.find((c) => c.name === name)!;

/**
 * For each chore, the ways it runs right now: "heartbeat" when the heartbeat
 * would run it from heartbeat.json, "engine" when its routine is switched on.
 */
async function waysOf(chores: RawChore[]): Promise<string[][]> {
  const inFile = (readHeartbeat().tasks as RawChore[]).filter((c) => c.enabled !== false);
  const onHeartbeat = await stillOnHeartbeat(inFile);
  const enabled = new Set((await listTasks()).filter((t) => t.enabled).map((t) => t.id));
  return chores.map((c) => [
    ...(onHeartbeat.some((h) => idOf(h) === idOf(c)) ? ["heartbeat"] : []),
    ...(enabled.has(idOf(c)) ? ["engine"] : []),
  ]);
}

/** Each chore runs exactly one way. */
async function assertExactlyOneWay(chores: RawChore[], when: string): Promise<string[]> {
  const ways = await waysOf(chores);
  ways.forEach((w, i) =>
    assert.equal(
      w.length,
      1,
      `${when}: "${String(chores[i]!.name)}" runs ${w.join("+") || "nowhere"}`,
    ),
  );
  return ways.map((w) => w[0]!);
}

/** Fail fs renames onto paths `match` accepts, `times` times. */
function failRenames(match: (target: string) => boolean, times = 1): { restore(): void } {
  const real = fsp.rename.bind(fsp);
  let left = times;
  (fsp as { rename: typeof fsp.rename }).rename = async (from, to) => {
    if (left > 0 && match(String(to))) {
      left--;
      throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
    }
    return real(from, to);
  };
  return {
    restore: () => {
      (fsp as { rename: typeof fsp.rename }).rename = real;
    },
  };
}

test("schedules: the chore's own when valid, bare cron accepted, otherwise the REAL heartbeat cadence", () => {
  assert.deepEqual(scheduleForChore("daily:08:00", 1800), {
    schedule: { expr: "daily:08:00" },
    cadence: "own",
  });
  assert.deepEqual(scheduleForChore("0 18 * * 5", 1800).schedule, { expr: "cron:0 18 * * 5" });
  // No schedule of its own: it ran on every tick, at whatever interval the job fires.
  assert.deepEqual(scheduleForChore(undefined, 3600), {
    schedule: { expr: "every:1h" },
    cadence: "heartbeat",
  });
  assert.deepEqual(scheduleForChore(undefined, 900).schedule, { expr: "every:15m" });
  assert.deepEqual(scheduleForChore("when I feel like it", 5400).schedule, { expr: "every:90m" });
  assert.deepEqual(
    scheduleForChore(undefined, 60).schedule,
    { expr: "every:5m" },
    "clamped to the engine's floor",
  );
  assert.deepEqual(
    scheduleForChore("* * * * *", 1800).schedule,
    { expr: "every:30m" },
    "below the floor",
  );
  // Nothing installed: 30 minutes, and it says it is an assumption.
  assert.deepEqual(scheduleForChore(undefined, null), {
    schedule: { expr: "every:30m" },
    cadence: "assumed",
  });
});

test("the installed launchd interval is read from the plist", async () => {
  const plist = path.join(home, "ai.lisa.heartbeat.plist");
  fs.writeFileSync(
    plist,
    "<plist><dict><key>StartInterval</key>\n  <integer>3600</integer></dict></plist>",
  );
  assert.equal(await installedHeartbeatIntervalSec(plist), 3600);
  assert.equal(await installedHeartbeatIntervalSec(path.join(home, "missing.plist")), null);
  fs.writeFileSync(plist, "<plist><dict><key>StartCalendarInterval</key></dict></plist>");
  assert.equal(await installedHeartbeatIntervalSec(plist), null);
});

test("the heartbeat's token ceiling becomes each chore's ceiling", () => {
  assert.equal(budgetForChore(250_000).tokens, 250_000);
  assert.equal(budgetForChore(undefined).tokens, 500_000, "the heartbeat's own default");
  assert.equal(budgetForChore(0).tokens, 2_000_000, "0 meant no limit: the engine's maximum");
  assert.equal(budgetForChore(50).tokens, 1000, "clamped to the engine's minimum");
  assert.equal(budgetForChore(9e12).tokens, 2_000_000);
});

test("--dry-run reports the plan and changes nothing", async () => {
  writeHeartbeat(CONFIG);
  const original = fs.readFileSync(heartbeatFile(), "utf8");
  const result = await migrate({ dryRun: true });
  assert.deepEqual(
    result.chores.map((c) => [c.title, c.schedule.expr, c.cadence, c.action, c.budget.tokens]),
    [
      ["inbox triage", "daily:08:00", "own", "migrate", 250_000],
      ["disk check", "every:30m", "heartbeat", "migrate", 250_000],
    ],
  );
  assert.deepEqual(
    result.left.map((l) => l.name),
    ["weekly review"],
    "a chore switched off in heartbeat.json is not moved",
  );
  assert.equal(fs.readFileSync(heartbeatFile(), "utf8"), original);
  assert.deepEqual(await listTasks(), []);
  assert.deepEqual(fs.readdirSync(home), ["heartbeat.json"], "no backup, no tasks dir, no lock");
  const text = describeMigration(result).join("\n");
  assert.match(text, /Would move "disk check"/);
  assert.match(text, /cannot run shell, file-writing or MCP tools/);
  assert.match(text, /Nothing was changed/);
});

test("migrating moves the chores that are on, with their schedule and budget; the file is backed up", async () => {
  writeHeartbeat(CONFIG);
  const original = fs.readFileSync(heartbeatFile(), "utf8");
  const result = await migrate();
  assert.deepEqual(result.migrated, ["inbox triage", "disk check"]);
  assert.deepEqual(
    result.left.map((l) => l.name),
    ["weekly review"],
  );

  const triage = (await getTask(idOf(chore("inbox triage"))))!;
  assert.equal(triage.kind, "routine");
  assert.equal(triage.instruction, "Triage my inbox.");
  assert.deepEqual(triage.origin, { kind: "heartbeat" });
  assert.deepEqual(triage.schedule, { expr: "daily:08:00" });
  assert.equal(triage.enabled, true);
  assert.equal(triage.createdDisabled, false);
  assert.equal(triage.state, "scheduled");
  assert.ok(triage.nextRunAt! > NOW);
  assert.equal(triage.notify, "silent_on_noop");
  assert.equal(triage.budget.tokens, 250_000);
  assert.deepEqual(triage.envelope, { categories: [HEARTBEAT_LEGACY_CATEGORY] });

  const disk = (await getTask(idOf(chore("disk check"))))!;
  assert.deepEqual(disk.schedule, { expr: "every:30m" });
  assert.equal(disk.nextRunAt, NOW, "it ran on every tick — it is due at once");

  // The chore the user had switched off is left exactly as it was.
  assert.equal(await getTask(idOf(chore("weekly review"))), null);

  assert.equal(fs.readFileSync(result.backup!, "utf8"), original);
  assert.deepEqual(readHeartbeat(), {
    budgetTokens: 250_000,
    somethingElse: { keep: "me" },
    tasks: [chore("weekly review")],
  });
  assert.match(describeMigration(result).join("\n"), new RegExp(MIGRATION_WARNING.slice(0, 40)));
});

test("builtin:* overrides are never migrated — a disabled builtin stays disabled", async () => {
  writeHeartbeat({
    tasks: [
      { name: "builtin:weekly_examen", prompt: "(disabled by me)", enabled: false },
      { name: "disk check", prompt: "Check." },
    ],
  });
  const result = await migrate();
  assert.deepEqual(result.migrated, ["disk check"]);
  assert.deepEqual(
    result.left.map((l) => l.name),
    ["builtin:weekly_examen"],
  );
  assert.deepEqual(readHeartbeat().tasks, [
    { name: "builtin:weekly_examen", prompt: "(disabled by me)", enabled: false },
  ]);
  assert.equal(
    await getTask(idOf({ name: "builtin:weekly_examen", prompt: "(disabled by me)" })),
    null,
  );
});

test("two chores with the same name both survive, as two routines; an exact copy is the same chore", async () => {
  const first = { name: "dup", prompt: "first prompt" };
  const second = { name: "dup", prompt: "second, different prompt" };
  writeHeartbeat({ tasks: [first, second, { ...first }] });
  const result = await migrate();
  assert.deepEqual(result.migrated, ["dup", "dup (2)"]);
  assert.deepEqual(
    result.chores.map((c) => c.action),
    ["migrate", "migrate", "duplicate"],
  );
  const tasks = await listTasks();
  assert.deepEqual(tasks.map((t) => t.instruction).sort(), [
    "first prompt",
    "second, different prompt",
  ]);
  assert.notEqual(idOf(first), idOf(second));
  assert.match(describeMigration(result).join("\n"), /exact copy of an earlier chore/);
  assert.deepEqual(readHeartbeat().tasks, []);
});

test("a chore is identified by its content, not its position: a chore that failed to move keeps running the old way, and a re-run moves it (reviewer probe h4-migrate)", async () => {
  const first = { name: "dup", prompt: "first" };
  const second = { name: "dup", prompt: "second" };
  writeHeartbeat({ tasks: [first, second] });
  // Creating the second routine fails (an I/O error on its task file).
  const fault = failRenames((to) => to.endsWith(`${idOf(second)}.json`));
  let result;
  try {
    result = await migrate();
  } finally {
    fault.restore();
  }
  assert.deepEqual(result.migrated, ["dup"]);
  assert.match(result.left[0]!.reason, /keeps running as before/);
  assert.deepEqual(readHeartbeat().tasks, [second], "only the moved chore left the file");
  // The failed one is now the FIRST "dup" in the file; it must not be taken
  // for the first chore's routine.
  assert.deepEqual(await assertExactlyOneWay([first, second], "after the partial failure"), [
    "engine",
    "heartbeat",
  ]);

  const rerun = await migrate({ now: NOW + 1000 });
  assert.deepEqual(rerun.migrated, ["dup"]);
  assert.deepEqual(readHeartbeat().tasks, []);
  assert.deepEqual(await assertExactlyOneWay([first, second], "after the re-run"), [
    "engine",
    "engine",
  ]);
  assert.deepEqual((await listTasks()).map((t) => t.instruction).sort(), ["first", "second"]);
});

test("running it again changes nothing", async () => {
  writeHeartbeat(CONFIG);
  await migrate();
  const tasksBefore = await listTasks();
  const filesBefore = fs.readdirSync(home).sort();
  const again = await migrate({ now: NOW + 1000 });
  assert.deepEqual(again.migrated, []);
  assert.equal(again.backup, undefined);
  assert.deepEqual(await listTasks(), tasksBefore);
  assert.deepEqual(fs.readdirSync(home).sort(), filesBefore, "no second backup");
});

test("at every crash point each chore runs exactly one way, and a re-run finishes the job", async () => {
  const chores = CONFIG.tasks.filter((c) => c.enabled !== false) as RawChore[];
  const disk = chore("disk check");
  writeHeartbeat({ tasks: chores });
  assert.deepEqual(await assertExactlyOneWay(chores, "before anything"), [
    "heartbeat",
    "heartbeat",
  ]);

  // Crash after step 1 for "disk check": its routine exists, but switching it
  // on fails (the second write of its task file).
  let writes = 0;
  const step2 = failRenames((to) => to.endsWith(`${idOf(disk)}.json`) && ++writes === 2);
  try {
    await migrate();
  } finally {
    step2.restore();
  }
  assert.ok(await getTask(idOf(disk)), "step 1 happened");
  assert.deepEqual(await assertExactlyOneWay(chores, "after step 1"), ["engine", "heartbeat"]);
  assert.deepEqual(readHeartbeat().tasks, [disk], "the chore that did not switch stays");

  // The re-run switches it on, then cleans up.
  const rerun = await migrate({ now: NOW + 1000 });
  assert.deepEqual(
    rerun.chores.map((c) => c.action),
    ["finish"],
  );
  assert.deepEqual(await assertExactlyOneWay(chores, "after the re-run"), ["engine", "engine"]);
  assert.deepEqual(readHeartbeat().tasks, []);

  // Crash between step 2 and step 3: heartbeat.json cannot be rewritten.
  fs.rmSync(path.join(home, "tasks"), { recursive: true, force: true });
  writeHeartbeat({ tasks: chores });
  const step3 = failRenames((to) => to === heartbeatFile());
  try {
    await assert.rejects(migrate({ now: NOW + 2000 }));
  } finally {
    step3.restore();
  }
  assert.equal(readHeartbeat().tasks.length, 2, "heartbeat.json still lists both");
  assert.deepEqual(await assertExactlyOneWay(chores, "after step 2"), ["engine", "engine"]);
  const cleanup = await migrate({ now: NOW + 3000 });
  assert.deepEqual(cleanup.migrated, []);
  assert.deepEqual(readHeartbeat().tasks, []);
  assert.deepEqual(await assertExactlyOneWay(chores, "after cleanup"), ["engine", "engine"]);
});

test("a routine the user switches off gives its chore back to the heartbeat; one the engine paused does not", async () => {
  const disk = chore("disk check");
  writeHeartbeat({ tasks: [disk] });
  const result = await migrate();
  assert.deepEqual(readHeartbeat().tasks, []);

  // The engine paused it (a schedule it cannot compute, a billing refusal …):
  // the user has been told; the chore does not silently fall back.
  await updateTask(idOf(disk), (t) => pauseTask(t, "its schedule cannot be computed"));
  fs.copyFileSync(result.backup!, heartbeatFile());
  assert.deepEqual(await waysOf([disk]), [[]], "paused by the engine: skipped, and the user knows");
  assert.deepEqual(await stillOnHeartbeat([disk]), []);

  // The user switches the routine off and restores the chore: the old way again.
  await updateTask(idOf(disk), (t) => {
    disableTask(t);
    delete t.pausedReason;
  });
  assert.deepEqual(await assertExactlyOneWay([disk], "routine off, chore restored"), ["heartbeat"]);

  // Asking to migrate again moves it again.
  const again = await migrate({ now: NOW + 1000 });
  assert.deepEqual(
    again.chores.map((c) => c.action),
    ["finish"],
  );
  assert.deepEqual(await assertExactlyOneWay([disk], "migrated again"), ["engine"]);
  assert.deepEqual(readHeartbeat().tasks, []);
});

test("the migration holds the heartbeat's run lock: it waits out a tick in progress, and gives up cleanly", async () => {
  writeHeartbeat({ tasks: [chore("disk check")] });
  // A heartbeat tick is in progress.
  const tickDone = deferred();
  const inTick = deferred();
  const tick = withFileLock(heartbeatRunLockPath(), async () => {
    inTick.resolve();
    await tickDone.promise;
  });
  await inTick.promise;
  await assert.rejects(migrate({ lockWaitMs: 100 }), /heartbeat run is in progress/);
  assert.equal(readHeartbeat().tasks.length, 1, "nothing was changed");
  assert.deepEqual(await listTasks(), []);

  const waiting = migrate({ lockWaitMs: 5000 });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(await listTasks(), [], "nothing moves while the tick runs");
  tickDone.resolve();
  await tick;
  assert.deepEqual((await waiting).migrated, ["disk check"]);

  // And while the migration holds it, a heartbeat tick cannot start.
  writeHeartbeat({ tasks: [{ name: "other", prompt: "Other." }] });
  const inMigration = deferred();
  const finish = deferred();
  const realReadFile = fsp.readFile.bind(fsp);
  (fsp as { readFile: unknown }).readFile = async (target: unknown, ...rest: unknown[]) => {
    if (String(target) === heartbeatFile()) {
      inMigration.resolve();
      await finish.promise;
    }
    return (realReadFile as (...a: unknown[]) => Promise<unknown>)(target, ...rest);
  };
  try {
    const moving = migrate({ now: NOW + 1000 });
    await inMigration.promise;
    let tickRan = false;
    await assert.rejects(
      withFileLock(
        heartbeatRunLockPath(),
        async () => {
          tickRan = true;
        },
        { timeoutMs: 0, staleMs: 6 * 3_600_000 },
      ),
      /timed out acquiring lock/,
    );
    assert.equal(tickRan, false);
    finish.resolve();
    assert.deepEqual((await moving).migrated, ["other"]);
  } finally {
    (fsp as { readFile: unknown }).readFile = realReadFile;
  }
});

test("stillOnHeartbeat keeps unmigrated chores, builtin overrides and same-name twins apart", async () => {
  const chores = [
    { name: "a", prompt: "1" },
    { name: "builtin:weekly_examen", prompt: "x", enabled: false },
    { name: "a", prompt: "2" },
  ];
  assert.deepEqual(await stillOnHeartbeat(chores), chores, "nothing migrated: everything stays");
  writeHeartbeat({ tasks: chores });
  await migrate();
  assert.deepEqual(await stillOnHeartbeat(chores), [chores[1]]);
  // Same name, different prompt or schedule: a different chore.
  const edited = { name: "a", prompt: "1, edited" };
  const rescheduled = { name: "a", prompt: "1", schedule: "daily:09:00" };
  assert.deepEqual(await stillOnHeartbeat([edited, rescheduled]), [edited, rescheduled]);
  // A task that merely has a heartbeat-looking id but did not come from heartbeat.json does not count.
  const unrelated = { name: "unrelated", prompt: "u" };
  await createTask(
    {
      id: idOf(unrelated),
      kind: "routine",
      title: "x",
      instruction: "x",
      origin: { kind: "api" },
      enabled: true,
    },
    NOW,
  );
  assert.deepEqual(await stillOnHeartbeat([unrelated]), [unrelated]);
});

test("a chore that cannot be migrated stays in heartbeat.json; a malformed file is left alone", async () => {
  writeHeartbeat({
    tasks: [{ name: "ok", prompt: "Fine." }, { name: "no prompt" }, { prompt: "no name" }],
  });
  const result = await migrate();
  assert.deepEqual(result.migrated, ["ok"]);
  assert.deepEqual(
    result.left.map((l) => l.name),
    ["no prompt", "(unnamed)"],
  );
  assert.deepEqual(readHeartbeat().tasks, [{ name: "no prompt" }, { prompt: "no name" }]);

  writeHeartbeat("{ not json");
  const broken = await migrate();
  assert.deepEqual(broken.migrated, []);
  assert.match(broken.left[0]!.reason, /unreadable/);
  assert.equal(fs.readFileSync(heartbeatFile(), "utf8"), "{ not json");
});

test("the hosted edition never migrates", async () => {
  writeHeartbeat(CONFIG);
  process.env.LISA_EDITION = "cloud";
  try {
    assert.deepEqual((await migrate()).chores, []);
    assert.equal(readHeartbeat().tasks.length, 3);
  } finally {
    delete process.env.LISA_EDITION;
  }
});

test("`lisa tasks migrate-heartbeat [--dry-run]` prints the plan and the warning", async () => {
  writeHeartbeat({ tasks: [{ name: "disk check", prompt: "Run df -h and tell me." }] });
  const out: string[] = [];
  const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(l), now: () => NOW };
  assert.equal(await runTasksCommand(["migrate-heartbeat", "--dry-run"], io), 0);
  assert.match(out.join("\n"), /Would move "disk check"/);
  assert.match(out.join("\n"), /cannot run shell, file-writing or MCP tools/);
  assert.equal(readHeartbeat().tasks.length, 1);
  assert.deepEqual(await listTasks(), []);

  out.length = 0;
  assert.equal(await runTasksCommand(["migrate-heartbeat"], io), 0);
  assert.match(out.join("\n"), /Moved "disk check"/);
  assert.match(out.join("\n"), /Backup of the original/);
  assert.equal((await listTasks()).length, 1);
  assert.deepEqual(readHeartbeat().tasks, []);
});
