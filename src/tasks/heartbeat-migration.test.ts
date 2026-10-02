import { test, before, after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HEARTBEAT_LEGACY_CATEGORY,
  heartbeatFile,
  heartbeatTaskId,
  migrateHeartbeatTasks,
  scheduleForChore,
} from "./heartbeat-migration.js";
import { getTask, listTasks } from "./store.js";

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
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-hb-migrate-"));
  process.env.LISA_HOME = home;
});

function writeHeartbeat(config: unknown): void {
  fs.writeFileSync(heartbeatFile(), typeof config === "string" ? config : JSON.stringify(config, null, 2));
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

test("schedules: the chore's own when valid, bare cron accepted, otherwise the old every-tick cadence", () => {
  assert.deepEqual(scheduleForChore("daily:08:00"), { expr: "daily:08:00" });
  assert.deepEqual(scheduleForChore("every:2h"), { expr: "every:2h" });
  assert.deepEqual(scheduleForChore("0 18 * * 5"), { expr: "cron:0 18 * * 5" });
  assert.deepEqual(scheduleForChore(undefined), { expr: "every:30m" });
  assert.deepEqual(scheduleForChore("when I feel like it"), { expr: "every:30m" });
  assert.deepEqual(scheduleForChore("every:1m"), { expr: "every:30m" }, "below the floor");
  assert.deepEqual(scheduleForChore("* * * * *"), { expr: "every:30m" }, "a every-minute cron is below the floor too");
});

test("no heartbeat.json, or one with no tasks, is a no-op", async () => {
  assert.deepEqual(await migrateHeartbeatTasks(NOW), { migrated: [], alreadyPresent: [], left: [] });
  writeHeartbeat({ budgetTokens: 1, tasks: [] });
  assert.deepEqual(await migrateHeartbeatTasks(NOW), { migrated: [], alreadyPresent: [], left: [] });
  assert.equal(fs.readdirSync(home).filter((n) => n.includes(".bak")).length, 0);
});

test("chores become routines with their schedule honoured; the file is backed up and emptied", async () => {
  writeHeartbeat(CONFIG);
  const original = fs.readFileSync(heartbeatFile(), "utf8");
  const result = await migrateHeartbeatTasks(NOW);
  assert.deepEqual(result.migrated, ["inbox triage", "disk check", "weekly review"]);
  assert.deepEqual(result.left, []);

  const triage = (await getTask(heartbeatTaskId("inbox triage")))!;
  assert.equal(triage.kind, "routine");
  assert.equal(triage.title, "inbox triage");
  assert.equal(triage.instruction, "Triage my inbox.");
  assert.deepEqual(triage.origin, { kind: "heartbeat" });
  assert.deepEqual(triage.schedule, { expr: "daily:08:00" });
  assert.equal(triage.enabled, true, "it was already running; it keeps running");
  assert.equal(triage.createdDisabled, false);
  assert.equal(triage.state, "scheduled");
  assert.ok(triage.nextRunAt! > NOW);
  assert.equal(triage.notify, "silent_on_noop");
  assert.equal(triage.host, "home");
  assert.deepEqual(triage.envelope, { categories: [HEARTBEAT_LEGACY_CATEGORY] });

  const disk = (await getTask(heartbeatTaskId("disk check")))!;
  assert.deepEqual(disk.schedule, { expr: "every:30m" });
  assert.equal(disk.nextRunAt, NOW, "a chore with no schedule ran on every tick — it is due at once");

  const weekly = (await getTask(heartbeatTaskId("weekly review")))!;
  assert.deepEqual(weekly.schedule, { expr: "cron:0 18 * * 5" });
  assert.equal(weekly.enabled, false, "a chore the user had switched off stays off");
  assert.equal(weekly.nextRunAt, undefined);

  // The backup is byte-identical; the live file keeps every other key.
  assert.equal(fs.readFileSync(result.backup!, "utf8"), original);
  assert.deepEqual(readHeartbeat(), { budgetTokens: 250_000, somethingElse: { keep: "me" }, tasks: [] });
});

test("running it again changes nothing", async () => {
  writeHeartbeat(CONFIG);
  await migrateHeartbeatTasks(NOW);
  const tasksBefore = await listTasks();
  const filesBefore = fs.readdirSync(home).sort();
  const again = await migrateHeartbeatTasks(NOW + 1000);
  assert.deepEqual(again, { migrated: [], alreadyPresent: [], left: [] });
  assert.deepEqual(await listTasks(), tasksBefore);
  assert.deepEqual(fs.readdirSync(home).sort(), filesBefore, "no second backup");
});

test("an interrupted migration finishes without duplicating routines", async () => {
  writeHeartbeat(CONFIG);
  await migrateHeartbeatTasks(NOW);
  // Crash before the rewrite: the routines exist, the file still lists the chores.
  writeHeartbeat(CONFIG);
  const result = await migrateHeartbeatTasks(NOW + 5000);
  assert.deepEqual(result.migrated, []);
  assert.deepEqual(result.alreadyPresent, ["inbox triage", "disk check", "weekly review"]);
  assert.equal((await listTasks()).length, 3);
  assert.deepEqual(readHeartbeat().tasks, []);
  assert.match(result.backup!, /\.pre-tasks\.\d+\.bak$/, "the first backup is not overwritten");
});

test("a chore added to heartbeat.json later is picked up on the next start", async () => {
  writeHeartbeat(CONFIG);
  await migrateHeartbeatTasks(NOW);
  writeHeartbeat({ budgetTokens: 250_000, tasks: [{ name: "new chore", prompt: "Do the new thing." }] });
  const result = await migrateHeartbeatTasks(NOW + 1000);
  assert.deepEqual(result.migrated, ["new chore"]);
  assert.equal((await listTasks()).length, 4);
});

test("a chore that cannot be migrated stays in heartbeat.json", async () => {
  writeHeartbeat({ tasks: [{ name: "ok", prompt: "Fine." }, { name: "no prompt" }, { prompt: "no name" }] });
  const result = await migrateHeartbeatTasks(NOW);
  assert.deepEqual(result.migrated, ["ok"]);
  assert.deepEqual(
    result.left.map((l) => l.name),
    ["no prompt", "(unnamed)"],
  );
  assert.deepEqual(readHeartbeat().tasks, [{ name: "no prompt" }, { prompt: "no name" }]);
});

test("a malformed heartbeat.json is left exactly as it is", async () => {
  writeHeartbeat("{ not json");
  assert.deepEqual(await migrateHeartbeatTasks(NOW), { migrated: [], alreadyPresent: [], left: [] });
  assert.equal(fs.readFileSync(heartbeatFile(), "utf8"), "{ not json");
  assert.equal((await listTasks()).length, 0);
});

test("the hosted edition never migrates", async () => {
  writeHeartbeat(CONFIG);
  process.env.LISA_EDITION = "cloud";
  try {
    assert.deepEqual(await migrateHeartbeatTasks(NOW), { migrated: [], alreadyPresent: [], left: [] });
    assert.equal(readHeartbeat().tasks.length, 3);
  } finally {
    delete process.env.LISA_EDITION;
  }
});
