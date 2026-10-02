import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pendingDeferred, scheduleQuietHoursCatchUp } from "./catchup.js";
import { DeferQueue } from "./defer.js";
import { reachOut } from "./gate.js";
import { readLedger, reachOutLedgerPath, type LedgerEntry } from "./ledger.js";
import {
  defaultReachOutSettings,
  saveReachOutSettings,
  type ReachOutSettings,
} from "./settings.js";
import type { ReachOutNotice, StampedNotice } from "./types.js";

// Zone pinned to UTC; default quiet hours 22:00–08:00.
const NIGHT = new Date("2026-10-02T23:30:00Z");
const RESTART = new Date("2026-10-03T01:00:00Z");
const MORNING = new Date("2026-10-03T08:00:00Z");

async function homeWith(patch: (s: ReachOutSettings) => void = () => {}): Promise<string> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-reachout-catchup-"));
  const s = defaultReachOutSettings();
  s.quietHours.tz = "UTC";
  patch(s);
  await saveReachOutSettings(s, home);
  return home;
}

const notice = (patch: Partial<ReachOutNotice> = {}): ReachOutNotice => ({
  uid: null,
  source: "mail",
  kind: "important",
  title: "SECRET-TITLE from Dana",
  body: "SECRET-BODY about the contract",
  priority: "high",
  actionable: true,
  ...patch,
});

/** One "process": its own in-memory queue and its own record of what was pushed. */
function proc(home: string) {
  const pushed: StampedNotice[] = [];
  const queue = new DeferQueue({ tickMs: 0 });
  const transports = {
    inapp: () => {},
    push: (n: StampedNotice) => void pushed.push(n),
  };
  return {
    pushed,
    queue,
    send: (n: ReachOutNotice, at: Date) =>
      reachOut(n, {
        home,
        now: () => at,
        proactiveMode: () => true,
        deferQueue: queue,
        transports,
      }),
    catchUp: (at: Date) =>
      scheduleQuietHoursCatchUp({ home, uid: null, transports, deferQueue: queue, now: () => at }),
  };
}

const releases = (home: string): LedgerEntry[] =>
  readLedger(home).filter((e) => e.type === "release");

test("pendingDeferred: deferred, unreleased, inside the window, decided before the cutoff", () => {
  const base = {
    v: 1 as const,
    type: "notice" as const,
    day: "2026-10-02",
    source: "mail" as const,
  };
  const mk = (
    id: string,
    ts: string,
    outcome: "delivered" | "deferred" | "dropped",
  ): LedgerEntry => ({
    ...base,
    id,
    ts,
    kind: "k",
    priority: "normal",
    solicited: false,
    outcome,
    channels: ["inapp"],
    deferred: outcome === "deferred" ? ["push"] : undefined,
    reason: "quiet-hours",
    budget: false,
    titleHash: "0".repeat(16),
    titleLen: 1,
    bodyLen: 1,
  });
  const entries: LedgerEntry[] = [
    mk("held", "2026-10-02T23:00:00Z", "deferred"),
    mk("released", "2026-10-02T23:10:00Z", "deferred"),
    { v: 1, type: "release", id: "released", ts: "2026-10-03T08:00:00Z", channels: ["push"] },
    mk("delivered", "2026-10-02T12:00:00Z", "delivered"),
    mk("dropped", "2026-10-02T12:00:00Z", "dropped"),
    mk("stale", "2026-10-01T23:00:00Z", "deferred"),
    mk("after-restart", "2026-10-03T02:00:00Z", "deferred"),
  ];
  const now = new Date("2026-10-03T08:00:00Z");
  assert.deepEqual(
    pendingDeferred(entries, now).map((e) => e.id),
    ["held", "after-restart"],
  );
  assert.deepEqual(
    pendingDeferred(entries, now, RESTART).map((e) => e.id),
    ["held"],
  );
});

test("a restart during quiet hours: one generic push at 08:00, with no notice content", async () => {
  const home = await homeWith();
  const before = proc(home);
  for (const i of [1, 2, 3]) {
    const out = await before.send(notice({ title: `SECRET-TITLE ${i}`, budgetKey: "poll" }), NIGHT);
    assert.deepEqual(out.deferred, ["push"]);
  }
  assert.equal(before.queue.size(), 3);
  // The process dies here: `before.queue` and its three held pushes are gone.

  const after = proc(home);
  assert.equal(after.catchUp(RESTART), 3);
  assert.equal(after.queue.size(), 1);
  assert.equal(await after.queue.flushDue(new Date("2026-10-03T07:59:00Z")), 0);
  assert.equal(after.pushed.length, 0);

  assert.equal(await after.queue.flushDue(MORNING), 1);
  assert.equal(after.pushed.length, 1);
  const push = after.pushed[0]!;
  assert.equal(push.title, "Lisa");
  assert.equal(push.body, "3 updates while you were in quiet hours");
  assert.equal(push.from, "Lisa");
  assert.equal(push.source, "mail");
  assert.equal(push.kind, "catch-up");
  assert.doesNotMatch(JSON.stringify(push), /SECRET/);
  assert.doesNotMatch(fs.readFileSync(reachOutLedgerPath(home), "utf8"), /SECRET|quiet hours/);

  // Each held notice is marked released, so a second restart sends nothing.
  assert.equal(releases(home).length, 3);
  const again = proc(home);
  assert.equal(again.catchUp(new Date("2026-10-03T08:05:00Z")), 0);
  assert.equal(again.queue.size(), 0);
});

test("a restart before it fires simply reschedules it — still sent once", async () => {
  const home = await homeWith();
  await proc(home).send(notice(), NIGHT);
  const second = proc(home);
  assert.equal(second.catchUp(RESTART), 1);
  // …and that process dies too, before 08:00.
  const third = proc(home);
  assert.equal(third.catchUp(new Date("2026-10-03T03:00:00Z")), 1);
  await third.queue.flushDue(MORNING);
  assert.equal(third.pushed.length, 1);
  assert.equal(third.pushed[0]!.body, "1 update while you were in quiet hours");
  assert.equal(second.pushed.length, 0);
});

test("a restart after quiet hours ended sends the catch-up right away", async () => {
  const home = await homeWith();
  await proc(home).send(notice(), NIGHT);
  const after = proc(home);
  const at = new Date("2026-10-03T09:15:00Z");
  assert.equal(after.catchUp(at), 1);
  assert.equal(await after.queue.flushDue(at), 1);
  assert.equal(after.pushed.length, 1);
});

test("nothing pending ⇒ nothing queued", async () => {
  const home = await homeWith();
  const p = proc(home);
  await p.send(notice(), new Date("2026-10-02T12:00:00Z")); // daytime: pushed live
  const after = proc(home);
  assert.equal(after.catchUp(RESTART), 0);
  assert.equal(after.queue.size(), 0);
});

test("pushes the live process released itself are not announced again", async () => {
  const home = await homeWith();
  const p = proc(home);
  await p.send(notice(), NIGHT);
  await p.queue.flushDue(MORNING); // released normally at 08:00
  assert.equal(p.pushed.length, 1);
  assert.equal(proc(home).catchUp(new Date("2026-10-03T08:30:00Z")), 0);
});

test("settings at release time are respected: dial off sends nothing, and is still marked done", async () => {
  const home = await homeWith();
  await proc(home).send(notice(), NIGHT);
  const after = proc(home);
  after.catchUp(RESTART);
  const off = defaultReachOutSettings();
  off.quietHours.tz = "UTC";
  off.dial = "off";
  await saveReachOutSettings(off, home);
  assert.equal(await after.queue.flushDue(MORNING), 1);
  assert.equal(after.pushed.length, 0);
  assert.equal(releases(home).length, 1);
  assert.equal(proc(home).catchUp(new Date("2026-10-03T08:10:00Z")), 0);
});

test("settings at release time: a source switched off is left out of the count; push channel off sends nothing", async () => {
  const home = await homeWith();
  const before = proc(home);
  await before.send(notice({ title: "m" }), NIGHT);
  await before.send(
    notice({ source: "idle", kind: "note", priority: "normal", title: "i" }),
    NIGHT,
  );
  const after = proc(home);
  assert.equal(after.catchUp(RESTART), 2);
  const s = defaultReachOutSettings();
  s.quietHours.tz = "UTC";
  s.sources.idle = false;
  await saveReachOutSettings(s, home);
  await after.queue.flushDue(MORNING);
  assert.equal(after.pushed.length, 1);
  assert.equal(after.pushed[0]!.body, "1 update while you were in quiet hours");
  assert.equal(releases(home).length, 2);

  const home2 = await homeWith();
  await proc(home2).send(notice(), NIGHT);
  const after2 = proc(home2);
  after2.catchUp(RESTART);
  const noPush = defaultReachOutSettings();
  noPush.quietHours.tz = "UTC";
  noPush.channels.push = false;
  await saveReachOutSettings(noPush, home2);
  await after2.queue.flushDue(MORNING);
  assert.equal(after2.pushed.length, 0);
});

test("quiet hours extended meanwhile ⇒ the catch-up waits for the new end", async () => {
  const home = await homeWith();
  await proc(home).send(notice(), NIGHT);
  const after = proc(home);
  after.catchUp(RESTART);
  const longer = defaultReachOutSettings();
  longer.quietHours.tz = "UTC";
  longer.quietHours.end = "10:00";
  await saveReachOutSettings(longer, home);
  assert.equal(await after.queue.flushDue(MORNING), 0);
  assert.equal(after.pushed.length, 0);
  assert.equal(await after.queue.flushDue(new Date("2026-10-03T10:00:00Z")), 1);
  assert.equal(after.pushed.length, 1);
});

test("notices deferred after the restart keep their own push and are not double-counted", async () => {
  const home = await homeWith();
  await proc(home).send(notice({ title: "old" }), NIGHT);
  const after = proc(home);
  assert.equal(after.catchUp(RESTART), 1);
  const live = await after.send(
    notice({ title: "new", body: "fresh" }),
    new Date("2026-10-03T02:00:00Z"),
  );
  assert.deepEqual(live.deferred, ["push"]);

  await after.queue.flushDue(MORNING);
  assert.equal(after.pushed.length, 2);
  const bodies = after.pushed.map((p) => p.body).sort();
  assert.deepEqual(bodies, ["1 update while you were in quiet hours", "fresh"]);
  // One release line per notice — none twice.
  const ids = releases(home).map((e) => e.id);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2);
});

test("the catch-up spends no budget", async () => {
  const home = await homeWith();
  await proc(home).send(notice(), NIGHT);
  const after = proc(home);
  after.catchUp(RESTART);
  await after.queue.flushDue(MORNING);
  const budgeted = readLedger(home).filter((e) => e.type === "notice" && e.budget);
  assert.equal(budgeted.length, 1); // only the original decision, last night
});

test("a transport that throws is logged, and the notices are still marked done", async () => {
  const home = await homeWith();
  await proc(home).send(notice(), NIGHT);
  const queue = new DeferQueue({ tickMs: 0 });
  const logs: string[] = [];
  scheduleQuietHoursCatchUp({
    home,
    uid: null,
    deferQueue: queue,
    now: () => RESTART,
    log: (m) => logs.push(m),
    transports: {
      push: () => {
        throw new Error("ntfy down");
      },
    },
  });
  assert.equal(await queue.flushDue(MORNING), 1);
  assert.ok(logs.some((l) => l.includes("catch-up push failed: ntfy down")));
  assert.equal(releases(home).length, 1);
});
