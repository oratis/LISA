import { test } from "node:test";
import assert from "node:assert/strict";
import {
  everyIntervalMs,
  firstRun,
  isOneShot,
  nextRun,
  parseSchedule,
  validateSchedule,
  zonedTimeToUtc,
} from "./schedule.js";

const NY = "America/New_York";
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const at = (s: string) => Date.parse(s);

test("parseSchedule recognises every documented form", () => {
  assert.deepEqual(parseSchedule("every:30m"), { kind: "every", everyMs: 30 * 60_000 });
  assert.deepEqual(parseSchedule("every:2h"), { kind: "every", everyMs: 2 * 3_600_000 });
  assert.equal(parseSchedule("at:2026-10-05T09:00:00Z")?.kind, "at");
  assert.equal(parseSchedule("daily:09:00")?.kind, "calendar");
  assert.equal(parseSchedule("weekdays:08:30")?.kind, "calendar");
  assert.equal(parseSchedule("weekly:mon@07:15")?.kind, "calendar");
  assert.equal(parseSchedule("cron:*/15 9-17 * * 1-5")?.kind, "calendar");
});

test("parseSchedule rejects malformed input", () => {
  for (const bad of [
    "",
    "hourly",
    "every:0m",
    "every:5w",
    "daily:24:00",
    "daily:09:60",
    "weekly:funday@09:00",
    "weekly:mon",
    "at:not-a-date",
    "cron:* * * *",
    "cron:61 * * * *",
    "cron:* 24 * * *",
    "cron:5-1 * * * *",
    "cron:*/0 * * * *",
    "cron:a b c d e",
    "x".repeat(300),
  ]) {
    assert.equal(parseSchedule(bad), null, bad);
  }
});

test("validateSchedule enforces the every: floor per edition", () => {
  assert.equal(validateSchedule({ expr: "every:5m" }), null);
  assert.match(validateSchedule({ expr: "every:4m" })!, /at least 5 minutes/);
  assert.match(validateSchedule({ expr: "every:5m" }, { cloud: true })!, /at least 30 minutes/);
  assert.equal(validateSchedule({ expr: "every:30m" }, { cloud: true }), null);
});

test("validateSchedule applies the same floor to dense crons", () => {
  assert.match(validateSchedule({ expr: "cron:* * * * *" })!, /more often/);
  assert.equal(validateSchedule({ expr: "cron:*/5 * * * *" }), null);
  assert.match(validateSchedule({ expr: "cron:*/5 * * * *" }, { cloud: true })!, /more often/);
  assert.equal(validateSchedule({ expr: "cron:0,30 * * * *" }, { cloud: true }), null);
  // 58 → 00 of the next hour is a 2-minute gap.
  assert.match(validateSchedule({ expr: "cron:0,58 * * * *" })!, /more often/);
  // …but not when the listed hours are not adjacent.
  assert.equal(validateSchedule({ expr: "cron:0,58 9 * * *" }), null);
});

test("validateSchedule rejects unknown zones and unknown forms", () => {
  assert.match(validateSchedule({ expr: "daily:09:00", tz: "Mars/Olympus" })!, /time zone/);
  assert.match(validateSchedule({ expr: "sometimes" })!, /unrecognised/);
  assert.equal(validateSchedule({ expr: "daily:09:00", tz: NY }), null);
});

test("every: is anchored on `from`", () => {
  const from = at("2026-10-02T10:00:00Z");
  assert.equal(nextRun({ expr: "every:30m" }, from), from + 30 * 60_000);
  assert.equal(everyIntervalMs("every:1d"), 86_400_000);
  assert.equal(everyIntervalMs("daily:09:00"), null);
});

test("at: fires once, and firstRun still honours an overdue one", () => {
  const spec = { expr: "at:2026-10-05T09:00:00Z" };
  assert.equal(iso(nextRun(spec, at("2026-10-01T00:00:00Z"))), "2026-10-05T09:00:00.000Z");
  assert.equal(nextRun(spec, at("2026-10-05T09:00:00Z")), null);
  assert.equal(iso(firstRun(spec, at("2026-10-06T00:00:00Z"))), "2026-10-05T09:00:00.000Z");
  assert.equal(isOneShot(spec), true);
  assert.equal(isOneShot({ expr: "daily:09:00" }), false);
});

test("daily: is strictly after `from`, in the given zone", () => {
  const spec = { expr: "daily:09:00", tz: NY };
  // 2026-10-02 is EDT (UTC-4): 09:00 local = 13:00Z.
  assert.equal(iso(nextRun(spec, at("2026-10-02T12:59:00Z"))), "2026-10-02T13:00:00.000Z");
  assert.equal(iso(nextRun(spec, at("2026-10-02T13:00:00Z"))), "2026-10-03T13:00:00.000Z");
});

test("daily: keeps wall-clock time across both DST transitions", () => {
  const spec = { expr: "daily:09:00", tz: NY };
  // Spring forward 2026-03-08: EST (UTC-5) → EDT (UTC-4).
  assert.equal(iso(nextRun(spec, at("2026-03-07T15:00:00Z"))), "2026-03-08T13:00:00.000Z");
  assert.equal(iso(nextRun(spec, at("2026-03-06T15:00:00Z"))), "2026-03-07T14:00:00.000Z");
  // Fall back 2026-11-01: EDT → EST.
  assert.equal(iso(nextRun(spec, at("2026-10-31T14:00:00Z"))), "2026-11-01T14:00:00.000Z");
});

test("a time inside the spring-forward gap is shifted, not skipped", () => {
  const spec = { expr: "daily:02:30", tz: NY };
  // 02:30 does not exist on 2026-03-08; it fires at 03:30 EDT = 07:30Z.
  const fired = nextRun(spec, at("2026-03-08T05:00:00Z"));
  assert.equal(iso(fired), "2026-03-08T07:30:00.000Z");
  // …and exactly once: the next one is the following day at 02:30 EDT.
  assert.equal(iso(nextRun(spec, fired!)), "2026-03-09T06:30:00.000Z");
});

test("a time inside the fall-back overlap fires once, on the first occurrence", () => {
  const spec = { expr: "daily:01:30", tz: NY };
  // 01:30 happens twice on 2026-11-01 (05:30Z EDT, 06:30Z EST).
  const fired = nextRun(spec, at("2026-11-01T04:00:00Z"));
  assert.equal(iso(fired), "2026-11-01T05:30:00.000Z");
  assert.equal(iso(nextRun(spec, fired!)), "2026-11-02T06:30:00.000Z");
});

test("zonedTimeToUtc round-trips ordinary times", () => {
  assert.equal(
    iso(zonedTimeToUtc({ y: 2026, mo: 7, d: 4, h: 12, mi: 0 }, "Asia/Shanghai")),
    "2026-07-04T04:00:00.000Z",
  );
  assert.equal(
    iso(zonedTimeToUtc({ y: 2026, mo: 1, d: 1, h: 0, mi: 0 }, "UTC")),
    "2026-01-01T00:00:00.000Z",
  );
});

test("weekdays: skips the weekend", () => {
  const spec = { expr: "weekdays:08:30", tz: "UTC" };
  // 2026-10-02 is a Friday.
  assert.equal(iso(nextRun(spec, at("2026-10-02T08:30:00Z"))), "2026-10-05T08:30:00.000Z");
  assert.equal(iso(nextRun(spec, at("2026-10-02T08:29:00Z"))), "2026-10-02T08:30:00.000Z");
});

test("weekly: lands on the named weekday", () => {
  const spec = { expr: "weekly:sun@20:00", tz: "UTC" };
  assert.equal(iso(nextRun(spec, at("2026-10-02T00:00:00Z"))), "2026-10-04T20:00:00.000Z");
  assert.equal(iso(nextRun(spec, at("2026-10-04T20:00:00Z"))), "2026-10-11T20:00:00.000Z");
});

test("cron: lists, ranges, steps and the dom/dow OR rule", () => {
  const utc = (expr: string) => ({ expr: `cron:${expr}`, tz: "UTC" });
  const from = at("2026-10-02T10:07:00Z"); // Friday
  assert.equal(iso(nextRun(utc("*/15 * * * *"), from)), "2026-10-02T10:15:00.000Z");
  assert.equal(iso(nextRun(utc("0 9-17/4 * * *"), from)), "2026-10-02T13:00:00.000Z");
  assert.equal(iso(nextRun(utc("0 0 1 * *"), from)), "2026-11-01T00:00:00.000Z");
  // dom=15 OR dow=Mon → Monday the 5th comes first.
  assert.equal(iso(nextRun(utc("0 0 15 * 1"), from)), "2026-10-05T00:00:00.000Z");
  // 7 is Sunday too.
  assert.equal(iso(nextRun(utc("0 0 * * 7"), from)), "2026-10-04T00:00:00.000Z");
  // Feb 29 is found across the leap-year horizon.
  assert.equal(iso(nextRun(utc("0 0 29 2 *"), from)), "2028-02-29T00:00:00.000Z");
});

test("nextRun is null for an unparseable spec", () => {
  assert.equal(nextRun({ expr: "whenever" }, Date.now()), null);
});
