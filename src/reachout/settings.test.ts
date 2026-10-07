import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DAILY_BUDGET,
  applyReachOutPatch,
  defaultReachOutSettings,
  loadReachOutSettings,
  normalizeReachOutSettings,
  reachOutSettingsPath,
  saveReachOutSettings,
} from "./settings.js";
import { REACH_OUT_SOURCES } from "./types.js";

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lisa-reachout-settings-"));
}

test("defaults match the charter: dial normal, 22:00–08:00, every source on, desire push off", () => {
  const d = defaultReachOutSettings();
  assert.equal(d.dial, "normal");
  assert.deepEqual(d.quietHours, { enabled: true, start: "22:00", end: "08:00", tz: null });
  for (const s of REACH_OUT_SOURCES) assert.equal(d.sources[s], true, s);
  assert.equal(d.desirePush, false);
  assert.deepEqual(d.compliance, {
    aiDisclosure: true,
    usageReminderMinutes: null,
    dependencyNudges: false,
  });
  assert.deepEqual({ ...DAILY_BUDGET }, { off: 0, low: 1, normal: 3, high: 8 });
});

test("missing file ⇒ defaults", () => {
  assert.deepEqual(loadReachOutSettings(tmpHome()), defaultReachOutSettings());
});

test("corrupt file ⇒ defaults (never louder than the charter)", () => {
  const home = tmpHome();
  fs.mkdirSync(path.dirname(reachOutSettingsPath(home)), { recursive: true });
  fs.writeFileSync(reachOutSettingsPath(home), "{ not json");
  assert.deepEqual(loadReachOutSettings(home), defaultReachOutSettings());
  fs.writeFileSync(reachOutSettingsPath(home), JSON.stringify([1, 2, 3]));
  assert.deepEqual(loadReachOutSettings(home), defaultReachOutSettings());
});

test("ill-typed fields fall back one by one", () => {
  const s = normalizeReachOutSettings({
    dial: "LOUD",
    sources: { mail: false, brief: "no", bogus: false },
    quietHours: { start: "25:00", end: "08:00", tz: "Not/AZone" },
    channels: { push: false, im: 1 },
    desirePush: "yes",
    compliance: { aiDisclosure: false, usageReminderMinutes: 3, dependencyNudges: true },
  });
  assert.equal(s.dial, "normal");
  assert.equal(s.sources.mail, false);
  assert.equal(s.sources.brief, true);
  assert.equal(s.quietHours.start, "22:00");
  assert.equal(s.quietHours.tz, null);
  assert.equal(s.channels.push, false);
  assert.equal(s.channels.im, false);
  assert.equal(s.desirePush, false);
  assert.equal(s.compliance.aiDisclosure, true);
  assert.equal(s.compliance.usageReminderMinutes, null);
  assert.equal(s.compliance.dependencyNudges, true);
});

test("approval can never be stored as off", () => {
  assert.equal(normalizeReachOutSettings({ sources: { approval: false } }).sources.approval, true);
  const r = applyReachOutPatch(defaultReachOutSettings(), { sources: { approval: false } });
  assert.equal(r.ok, false);
});

test("save → load round-trips atomically and leaves no temp files", async () => {
  const home = tmpHome();
  const next = defaultReachOutSettings();
  next.dial = "low";
  next.sources.brief = false;
  next.quietHours = { enabled: true, start: "23:30", end: "07:15", tz: "Asia/Shanghai" };
  await saveReachOutSettings(next, home);
  assert.deepEqual(loadReachOutSettings(home), next);
  assert.deepEqual(fs.readdirSync(path.dirname(reachOutSettingsPath(home))), ["settings.json"]);
});

test("patch validation rejects bad input instead of ignoring it", () => {
  const cur = defaultReachOutSettings();
  const bad: unknown[] = [
    null,
    [],
    { dial: "max" },
    { sources: { nope: true } },
    { sources: { mail: "off" } },
    { quietHours: { start: "8:00" } },
    { quietHours: { start: "09:00", end: "09:00" } },
    { quietHours: { tz: "Mars/Olympus" } },
    { channels: { sms: true } },
    { desirePush: 1 },
    { compliance: { aiDisclosure: false } },
    { compliance: { usageReminderMinutes: 5 } },
    { volume: 11 },
  ];
  for (const p of bad) assert.equal(applyReachOutPatch(cur, p).ok, false, JSON.stringify(p));
});

test("patch merges over current settings", () => {
  const r = applyReachOutPatch(defaultReachOutSettings(), {
    dial: "high",
    sources: { advisor: false },
    quietHours: { start: "21:00", tz: "Europe/Berlin" },
    compliance: { usageReminderMinutes: 120 },
  });
  assert.ok(r.ok);
  assert.equal(r.settings.dial, "high");
  assert.equal(r.settings.sources.advisor, false);
  assert.equal(r.settings.sources.mail, true);
  assert.deepEqual(r.settings.quietHours, {
    enabled: true,
    start: "21:00",
    end: "08:00",
    tz: "Europe/Berlin",
  });
  assert.equal(r.settings.compliance.usageReminderMinutes, 120);
});

test("tenant isolation: one home's settings do not leak into another", async () => {
  const a = tmpHome();
  const b = tmpHome();
  const s = defaultReachOutSettings();
  s.dial = "off";
  await saveReachOutSettings(s, a);
  assert.equal(loadReachOutSettings(a).dial, "off");
  assert.equal(loadReachOutSettings(b).dial, "normal");
});
