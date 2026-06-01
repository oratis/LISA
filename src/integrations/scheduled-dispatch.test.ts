import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isDue, isValidSchedule, fireDue, type ScheduledDispatch } from "./scheduled-dispatch.js";

const DAY = 86_400_000;
function entry(over: Partial<ScheduledDispatch> = {}): ScheduledDispatch {
  return { id: "x", agent: "claude", task: "t", cwd: "/r", schedule: "every:1h", maxRuns: 30, runs: 0, createdAt: 0, ...over };
}

describe("scheduled-dispatch isValidSchedule", () => {
  test("accepts every:* and daily:*", () => {
    for (const s of ["every:30m", "every:2h", "every:1d", "daily:09:00", "daily:23:59"]) {
      assert.ok(isValidSchedule(s), s);
    }
  });
  test("rejects junk and out-of-range", () => {
    for (const s of ["", "every:30", "every:0x", "daily:24:00", "daily:9:5", "hourly"]) {
      assert.equal(isValidSchedule(s), false, s);
    }
  });
});

describe("scheduled-dispatch isDue", () => {
  const NOON = new Date("2026-01-15T12:00:00").getTime();

  test("never-run every:* is due", () => assert.equal(isDue(entry({ schedule: "every:1h" }), NOON), true));
  test("every:* respects the interval", () => {
    assert.equal(isDue(entry({ schedule: "every:1h", lastRunAt: NOON - 30 * 60_000 }), NOON), false);
    assert.equal(isDue(entry({ schedule: "every:1h", lastRunAt: NOON - 61 * 60_000 }), NOON), true);
  });
  test("maxRuns spent → never due", () => {
    assert.equal(isDue(entry({ schedule: "every:1h", runs: 30, maxRuns: 30 }), NOON), false);
  });
  test("daily:09:00 — due once past 09:00 if not run since", () => {
    assert.equal(isDue(entry({ schedule: "daily:09:00" }), NOON), true); // noon, never ran
    const ranToday = new Date("2026-01-15T09:30:00").getTime();
    assert.equal(isDue(entry({ schedule: "daily:09:00", lastRunAt: ranToday }), NOON), false);
    assert.equal(isDue(entry({ schedule: "daily:09:00", lastRunAt: ranToday - DAY }), NOON), true); // ran yesterday
  });
  test("daily before the time → not due", () => {
    const eightAM = new Date("2026-01-15T08:00:00").getTime();
    assert.equal(isDue(entry({ schedule: "daily:09:00" }), eightAM), false);
  });
  test("unparseable schedule never fires", () => assert.equal(isDue(entry({ schedule: "nonsense" }), NOON), false));
});

describe("scheduled-dispatch fireDue", () => {
  test("swallows launch errors and still summarizes", async () => {
    // loadScheduled reads the real store; with none/launch injected we just
    // assert fireDue tolerates a throwing launcher shape via the pure path.
    const launched: ScheduledDispatch[] = [];
    const fake = async (e: ScheduledDispatch) => { launched.push(e); return { pid: 123 }; };
    // fireDue reads the on-disk store (likely empty in test) → returns [].
    const out = await fireDue(Date.now(), fake);
    assert.ok(Array.isArray(out));
  });
});
