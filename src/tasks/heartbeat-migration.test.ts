import { test, before, after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTasksCommand } from "../cli/tasks.js";
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
    result.chores.map((c) => [
      c.title,
      c.schedule.expr,
      c.cadence,
      c.enabled,
      c.action,
      c.budget.tokens,
    ]),
    [
      ["inbox triage", "daily:08:00", "own", true, "migrate", 250_000],
      ["disk check", "every:30m", "heartbeat", true, "migrate", 250_000],
      ["weekly review", "cron:0 18 * * 5", "own", false, "migrate", 250_000],
    ],
  );
  assert.equal(fs.readFileSync(heartbeatFile(), "utf8"), original);
  assert.deepEqual(await listTasks(), []);
  assert.deepEqual(fs.readdirSync(home), ["heartbeat.json"], "no backup, no tasks dir, no lock");
  const text = describeMigration(result).join("\n");
  assert.match(text, /Would move "disk check"/);
  assert.match(text, /cannot run shell, file-writing or MCP tools/);
  assert.match(text, /Nothing was changed/);
});

test("migrating moves chores with their schedule, budget and on/off state; the file is backed up", async () => {
  writeHeartbeat(CONFIG);
  const original = fs.readFileSync(heartbeatFile(), "utf8");
  const result = await migrate();
  assert.deepEqual(result.migrated, ["inbox triage", "disk check", "weekly review"]);
  assert.deepEqual(result.left, []);

  const triage = (await getTask(heartbeatTaskId("inbox triage")))!;
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

  const disk = (await getTask(heartbeatTaskId("disk check")))!;
  assert.deepEqual(disk.schedule, { expr: "every:30m" });
  assert.equal(disk.nextRunAt, NOW, "it ran on every tick — it is due at once");

  const weekly = (await getTask(heartbeatTaskId("weekly review")))!;
  assert.equal(weekly.enabled, false, "a chore the user had switched off stays off");
  assert.equal(weekly.enabledAt, undefined);

  assert.equal(fs.readFileSync(result.backup!, "utf8"), original);
  assert.deepEqual(readHeartbeat(), {
    budgetTokens: 250_000,
    somethingElse: { keep: "me" },
    tasks: [],
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
  assert.equal(await getTask(heartbeatTaskId("builtin:weekly_examen")), null);
});

test("two chores with the same name both survive, as two routines", async () => {
  writeHeartbeat({
    tasks: [
      { name: "dup", prompt: "first prompt" },
      { name: "dup", prompt: "second, different prompt" },
    ],
  });
  const result = await migrate();
  assert.deepEqual(result.migrated, ["dup", "dup (2)"]);
  const tasks = await listTasks();
  assert.deepEqual(tasks.map((t) => t.instruction).sort(), [
    "first prompt",
    "second, different prompt",
  ]);
  assert.notEqual(heartbeatTaskId("dup", 0), heartbeatTaskId("dup", 1));
  assert.deepEqual(readHeartbeat().tasks, []);
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

test("at every crash point a chore is runnable exactly one way, and a re-run finishes the job", async () => {
  const chores = CONFIG.tasks.filter((c) => c.enabled !== false) as Array<{
    name: string;
    prompt: string;
  }>;
  const onHeartbeat = async () =>
    (await stillOnHeartbeat(readHeartbeat().tasks)).map((c: { name: string }) => c.name);
  const onEngine = async () => (await listTasks()).filter((t) => t.enabled).map((t) => t.title);
  writeHeartbeat({ tasks: chores });

  // Before anything: the old way only.
  assert.deepEqual(await onHeartbeat(), ["inbox triage", "disk check"]);
  assert.deepEqual(await onEngine(), []);

  // Crash after step 1 for "disk check": the routine exists, switched off.
  await createTask(
    {
      id: heartbeatTaskId("disk check"),
      kind: "routine",
      title: "disk check",
      instruction: "Check free disk space.",
      origin: { kind: "heartbeat" },
      schedule: { expr: "every:30m" },
    },
    NOW,
  );
  assert.deepEqual(await onHeartbeat(), ["inbox triage", "disk check"], "still the old way");
  assert.deepEqual(await onEngine(), []);

  // The re-run finishes it: step 2 for both, then step 3.
  const rerun = await migrate();
  assert.deepEqual(
    rerun.chores.map((c) => c.action),
    ["migrate", "finish"],
  );
  assert.deepEqual((await onEngine()).sort(), ["disk check", "inbox triage"]);

  // Crash between step 2 and step 3: heartbeat.json still lists them.
  writeHeartbeat({ tasks: chores });
  assert.deepEqual(
    await onHeartbeat(),
    [],
    "the heartbeat skips a chore whose routine was switched on",
  );
  assert.deepEqual((await onEngine()).sort(), ["disk check", "inbox triage"]);

  // …even after the user pauses the routine: it does not come back the old way.
  await updateTask(heartbeatTaskId("disk check"), (t) => {
    t.enabled = false;
    t.state = "paused";
  });
  assert.deepEqual(await onHeartbeat(), []);

  // The next re-run only cleans up.
  const cleanup = await migrate({ now: NOW + 5000 });
  assert.deepEqual(cleanup.migrated, []);
  assert.deepEqual(readHeartbeat().tasks, []);
  assert.equal((await listTasks()).length, 2);
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
  // A task that merely shares the id but did not come from heartbeat.json does not count.
  assert.deepEqual(await stillOnHeartbeat([{ name: "unrelated" }]), [{ name: "unrelated" }]);
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
