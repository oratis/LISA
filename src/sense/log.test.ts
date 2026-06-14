import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendSenseEvent, readSenseEvents } from "./log.js";
import type { SenseEvent } from "./types.js";

let home: string;
let prev: string | undefined;
beforeEach(() => {
  prev = process.env.LISA_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-sense-"));
  process.env.LISA_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = prev;
  fs.rmSync(home, { recursive: true, force: true });
});

function ev(over: Partial<SenseEvent> = {}): SenseEvent {
  return { signal: "screen", kind: "foreground-app", app: "Code", summary: "switched to Code", ts: 1000, ...over };
}

describe("sense event log", () => {
  test("append then read round-trips", () => {
    appendSenseEvent(ev({ app: "Safari", ts: 1000 }), 1000);
    appendSenseEvent(ev({ app: "Code", ts: 2000 }), 2000);
    const all = readSenseEvents(2000);
    assert.deepEqual(all.map((e) => e.app), ["Safari", "Code"]);
  });

  test("missing file → []", () => {
    assert.deepEqual(readSenseEvents(1000), []);
  });

  test("corrupt lines are skipped, valid ones kept", () => {
    fs.mkdirSync(path.join(home, "sense"), { recursive: true });
    fs.writeFileSync(
      path.join(home, "sense", "events.jsonl"),
      "{ broken\n" + JSON.stringify(ev({ app: "Code", ts: 1000 })) + "\n",
    );
    const all = readSenseEvents(1000);
    assert.equal(all.length, 1);
    assert.equal(all[0]!.app, "Code");
  });

  test("events past the retention window are dropped on read", () => {
    const DAY = 24 * 60 * 60_000;
    appendSenseEvent(ev({ app: "Old", ts: 0 }), 0);
    const now = 10 * DAY;
    appendSenseEvent(ev({ app: "Fresh", ts: now }), now);
    assert.deepEqual(readSenseEvents(now, 7).map((e) => e.app), ["Fresh"]);
  });
});
