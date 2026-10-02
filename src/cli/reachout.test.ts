import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { parseArgs } from "../cli-args.js";
import { loadReachOutSettings } from "../reachout/settings.js";
import { runReachOutCommand, type ReachOutCliIo } from "./reachout.js";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.LISA_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-reachout-cli-"));
  process.env.LISA_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function io(): ReachOutCliIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    log: (l) => void out.push(l),
    error: (l) => void err.push(l),
    now: () => new Date(2026, 9, 2, 12, 0, 0),
  };
}

test("`lisa reachout …` is parsed as a subcommand with its arguments", () => {
  const args = parseArgs(["reachout", "set", "dial", "low"]);
  assert.equal(args.subcommand, "reachout");
  assert.deepEqual(args.subargs, ["set", "dial", "low"]);
  assert.deepEqual(parseArgs(["reachout", "quiet", "23:00-07:00"]).subargs, [
    "quiet",
    "23:00-07:00",
  ]);
});

test("show (the default) prints the dial, budget, quiet hours and every source", async () => {
  const t = io();
  assert.equal(await runReachOutCommand([], t), 0);
  const text = t.out.join("\n");
  assert.match(text, /dial\s+normal/);
  assert.match(text, /0\/3 unsolicited pushes used today/);
  assert.match(text, /22:00–08:00/);
  for (const s of [
    "task",
    "watcher",
    "approval",
    "mail",
    "brief",
    "advisor",
    "idle",
    "desire",
    "system",
  ]) {
    assert.match(text, new RegExp(`● on\\s+${s}\\b`));
  }
});

test("set dial persists and rejects an unknown value", async () => {
  const t = io();
  assert.equal(await runReachOutCommand(["set", "dial", "low"], t), 0);
  assert.equal(loadReachOutSettings(home).dial, "low");
  assert.match(t.out.join("\n"), /up to 1 unsolicited push a day/);
  assert.equal(await runReachOutCommand(["dial", "off"], t), 0);
  assert.equal(loadReachOutSettings(home).dial, "off");
  assert.equal(await runReachOutCommand(["set", "dial", "max"], t), 1);
  assert.equal(await runReachOutCommand(["set"], t), 1);
  assert.equal(loadReachOutSettings(home).dial, "off");
  assert.ok(t.err.length >= 2);
});

test("quiet sets a window, a zone, and can be switched off and on", async () => {
  const t = io();
  assert.equal(await runReachOutCommand(["quiet", "23:30-07:15", "Asia/Shanghai"], t), 0);
  assert.deepEqual(loadReachOutSettings(home).quietHours, {
    enabled: true,
    start: "23:30",
    end: "07:15",
    tz: "Asia/Shanghai",
  });
  assert.equal(await runReachOutCommand(["quiet", "off"], t), 0);
  assert.equal(loadReachOutSettings(home).quietHours.enabled, false);
  assert.equal(loadReachOutSettings(home).quietHours.start, "23:30");
  assert.equal(await runReachOutCommand(["quiet", "on", "local"], t), 0);
  assert.deepEqual(loadReachOutSettings(home).quietHours, {
    enabled: true,
    start: "23:30",
    end: "07:15",
    tz: null,
  });
  for (const bad of [
    ["quiet"],
    ["quiet", "9-5"],
    ["quiet", "25:00-07:00"],
    ["quiet", "22:00-08:00", "Mars/Base"],
  ]) {
    assert.equal(await runReachOutCommand(bad, t), 1, bad.join(" "));
  }
});

test("source toggles one source; approval cannot be turned off", async () => {
  const t = io();
  assert.equal(await runReachOutCommand(["source", "brief", "off"], t), 0);
  assert.equal(loadReachOutSettings(home).sources.brief, false);
  assert.equal(loadReachOutSettings(home).sources.mail, true);
  assert.equal(await runReachOutCommand(["source", "brief", "on"], t), 0);
  assert.equal(loadReachOutSettings(home).sources.brief, true);
  assert.equal(await runReachOutCommand(["source", "approval", "off"], t), 1);
  assert.match(t.err.join("\n"), /approval cannot be turned off/);
  assert.equal(await runReachOutCommand(["source", "nope", "off"], t), 1);
  assert.equal(await runReachOutCommand(["source", "mail"], t), 1);
});

test("ledger prints a summary and validates days; unknown subcommand prints usage", async () => {
  const t = io();
  assert.equal(await runReachOutCommand(["ledger"], t), 0);
  assert.match(t.out.join("\n"), /useful rate n\/a/);
  assert.equal(await runReachOutCommand(["ledger", "0"], t), 1);
  assert.equal(await runReachOutCommand(["frobnicate"], t), 1);
  assert.match(t.err.join("\n"), /Usage:/);
});
