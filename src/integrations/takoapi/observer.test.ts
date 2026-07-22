import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildTakoSessions, pinsOf, TakoApiObserver } from "./observer.js";
import { recordTakoCall, type TakoCallEntry } from "./ledger.js";

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60_000;
function entry(o: Partial<TakoCallEntry> = {}): TakoCallEntry {
  return { slug: "a", lastState: "completed", lastMtime: NOW - 1000, startedAt: NOW - 1000, ...o };
}

describe("buildTakoSessions (pure)", () => {
  test("maps a called agent to a takoapi session with its TaskState", () => {
    const out = buildTakoSessions([entry({ slug: "a", lastState: "working" })], [], NOW);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.agent, "takoapi");
    assert.equal(out[0]!.sessionId, "a");
    assert.equal(out[0]!.project, "a");
    assert.equal(out[0]!.state, "working");
  });

  test("drops calls outside the active window", () => {
    assert.equal(buildTakoSessions([entry({ lastMtime: NOW - 5 * HOUR })], [], NOW).length, 0);
  });

  test("pinned-but-uncalled shows idle; pinned-AND-called keeps its real state", () => {
    const out = buildTakoSessions(
      [entry({ slug: "called", lastState: "working" })],
      ["called", "idlePin"],
      NOW,
    );
    const byId = Object.fromEntries(out.map((s) => [s.sessionId, s]));
    assert.equal(byId["called"]!.state, "working"); // a called pin is NOT overwritten
    assert.equal(byId["idlePin"]!.state, "idle");
    assert.equal(byId["idlePin"]!.stateReason, "pinned");
  });

  test("never invents registry agents — empty calls + no pins ⇒ empty", () => {
    assert.deepEqual(buildTakoSessions([], [], NOW), []);
  });
});

describe("pinsOf", () => {
  test("reads a string[] pin and ignores junk / absence", () => {
    assert.deepEqual(pinsOf({ pin: ["a", 1, "b"] }), ["a", "b"]);
    assert.deepEqual(pinsOf({}), []);
    assert.deepEqual(pinsOf({ pin: "nope" }), []);
  });
});

describe("TakoApiObserver (ledger-driven, lisaHome()-tmp)", () => {
  let home: string;
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.LISA_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-tako-obs-"));
    process.env.LISA_HOME = home;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.LISA_HOME;
    else process.env.LISA_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("emits a session live when the tool records a call", async () => {
    const obs = new TakoApiObserver({ enabled: true });
    const seen: string[] = [];
    await obs.start((s) => seen.push(`${s.sessionId}:${s.state}`));
    recordTakoCall({ slug: "remote-x", state: "completed" });
    await obs.stop();
    assert.ok(seen.includes("remote-x:done"), `expected a live emit, got ${JSON.stringify(seen)}`);
  });

  test("list() reflects the ledger snapshot", async () => {
    recordTakoCall({ slug: "y", state: "working" });
    const obs = new TakoApiObserver({ enabled: true });
    const got = obs.list();
    assert.equal(got.length, 1);
    assert.equal(got[0]!.sessionId, "y");
    assert.equal(got[0]!.state, "working");
  });

  test("stop() unsubscribes — no emit after stop", async () => {
    const obs = new TakoApiObserver({ enabled: true });
    const seen: string[] = [];
    await obs.start((s) => seen.push(s.sessionId));
    await obs.stop();
    recordTakoCall({ slug: "after-stop", state: "completed" });
    assert.ok(!seen.includes("after-stop"), `should not emit after stop, got ${JSON.stringify(seen)}`);
  });
});
