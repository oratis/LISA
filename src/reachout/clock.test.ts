import { test } from "node:test";
import assert from "node:assert/strict";
import { inQuietHours, localMoment, quietHoursEnd } from "./clock.js";
import type { QuietHours } from "./settings.js";

const quiet = (patch: Partial<QuietHours> = {}): QuietHours => ({
  enabled: true,
  start: "22:00",
  end: "08:00",
  tz: "UTC",
  ...patch,
});

test("localMoment gives the calendar day and minute in the given zone", () => {
  const at = new Date("2026-10-02T16:30:00Z");
  assert.deepEqual(localMoment(at, "UTC"), { day: "2026-10-02", minutes: 16 * 60 + 30 });
  assert.deepEqual(localMoment(at, "Asia/Shanghai"), { day: "2026-10-03", minutes: 30 });
  assert.deepEqual(localMoment(at, "America/Los_Angeles"), {
    day: "2026-10-02",
    minutes: 9 * 60 + 30,
  });
});

test("localMoment with no zone uses the host's local clock", () => {
  const at = new Date(2026, 0, 5, 7, 45, 0);
  assert.deepEqual(localMoment(at, null), { day: "2026-01-05", minutes: 7 * 60 + 45 });
});

test("midnight is minute 0 of the new day, not minute 1440 of the old one", () => {
  assert.deepEqual(localMoment(new Date("2026-10-03T00:00:00Z"), "UTC"), {
    day: "2026-10-03",
    minutes: 0,
  });
});

test("a window that wraps midnight: start inclusive, end exclusive", () => {
  const q = quiet();
  const at = (hhmm: string, day = "02") => new Date(`2026-10-${day}T${hhmm}:00Z`);
  assert.equal(inQuietHours(at("21:59"), q), false);
  assert.equal(inQuietHours(at("22:00"), q), true);
  assert.equal(inQuietHours(at("23:59"), q), true);
  assert.equal(inQuietHours(at("00:00", "03"), q), true);
  assert.equal(inQuietHours(at("07:59", "03"), q), true);
  assert.equal(inQuietHours(at("08:00", "03"), q), false);
  assert.equal(inQuietHours(at("12:00"), q), false);
});

test("a same-day window", () => {
  const q = quiet({ start: "13:00", end: "14:30" });
  assert.equal(inQuietHours(new Date("2026-10-02T12:59:00Z"), q), false);
  assert.equal(inQuietHours(new Date("2026-10-02T13:00:00Z"), q), true);
  assert.equal(inQuietHours(new Date("2026-10-02T14:29:00Z"), q), true);
  assert.equal(inQuietHours(new Date("2026-10-02T14:30:00Z"), q), false);
});

test("disabled quiet hours are never quiet", () => {
  assert.equal(inQuietHours(new Date("2026-10-02T23:00:00Z"), quiet({ enabled: false })), false);
});

test("quiet hours follow the configured zone, not UTC", () => {
  const q = quiet({ tz: "Asia/Shanghai" });
  // 15:00 UTC = 23:00 in Shanghai (quiet); 01:00 UTC = 09:00 in Shanghai (not).
  assert.equal(inQuietHours(new Date("2026-10-02T15:00:00Z"), q), true);
  assert.equal(inQuietHours(new Date("2026-10-02T01:00:00Z"), q), false);
});

test("quietHoursEnd is the next time the local clock reads the end time", () => {
  const q = quiet();
  assert.equal(
    quietHoursEnd(new Date("2026-10-02T23:30:20Z"), q).toISOString(),
    "2026-10-03T08:00:00.000Z",
  );
  assert.equal(
    quietHoursEnd(new Date("2026-10-03T07:59:59Z"), q).toISOString(),
    "2026-10-03T08:00:00.000Z",
  );
  assert.equal(
    quietHoursEnd(new Date("2026-10-02T15:00:00Z"), quiet({ tz: "Asia/Shanghai" })).toISOString(),
    "2026-10-03T00:00:00.000Z", // 08:00 in Shanghai
  );
});
