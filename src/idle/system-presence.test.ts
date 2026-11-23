import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseConsoleLocked, parseHidIdleMs } from "./system-presence.js";
import { IdleWatcher } from "./watcher.js";

describe("system-presence parsers (Sense S2)", () => {
  test("parses HIDIdleTime in decimal and hex nanoseconds into milliseconds", () => {
    assert.equal(parseHidIdleMs('      "HIDIdleTime" = 2424875718791'), 2_424_875);
    assert.equal(parseHidIdleMs('      "HIDIdleTime" = 0x3b9aca00'), 1_000);
    assert.equal(parseHidIdleMs("no idle key here"), undefined);
  });

  test("parses IOConsoleLocked and CGSSessionScreenIsLocked booleans", () => {
    assert.equal(parseConsoleLocked('      "IOConsoleLocked" = Yes'), true);
    assert.equal(parseConsoleLocked('      "IOConsoleLocked" = No'), false);
    assert.equal(parseConsoleLocked('      "CGSSessionScreenIsLocked"=Yes'), true);
    assert.equal(parseConsoleLocked('      "CGSSessionScreenIsLocked"=No'), false);
    assert.equal(parseConsoleLocked("unrelated"), undefined);
  });
});

describe("IdleWatcher — OS presence integration", () => {
  test("suppresses idle firing while unlocked OS HID shows recent user activity", async () => {
    let osIdleMs = 200;
    let fired = 0;
    const watcher = new IdleWatcher({
      idleMs: 1_000,
      presenceProbe: async () => ({ available: true, idleMs: osIdleMs, locked: false }),
    });
    watcher.on("idle", () => {
      fired += 1;
    });

    // Force LISA chat timestamp past idleMs while OS still shows recent input.
    (watcher as unknown as { lastActivityAt: number }).lastActivityAt = Date.now() - 5_000;
    assert.equal(await watcher.checkNow(), false);
    assert.equal(fired, 0);

    // Once OS idle also exceeds threshold, idle fires once.
    osIdleMs = 5_000;
    (watcher as unknown as { lastActivityAt: number }).lastActivityAt = Date.now() - 5_000;
    assert.equal(await watcher.checkNow(), true);
    assert.equal(fired, 1);
  });

  test("locked screen does not suppress idle firing even if HIDIdleTime looks small", async () => {
    let fired = 0;
    const watcher = new IdleWatcher({
      idleMs: 1_000,
      presenceProbe: async () => ({ available: true, idleMs: 100, locked: true }),
    });
    watcher.on("idle", () => {
      fired += 1;
    });

    (watcher as unknown as { lastActivityAt: number }).lastActivityAt = Date.now() - 5_000;
    assert.equal(await watcher.checkNow(), true);
    assert.equal(fired, 1);
  });
});
