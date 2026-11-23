import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, test } from "node:test";

const execFileAsync = promisify(execFile);
import { parseArgs } from "../cli-args.js";
import { telemetryFile, trackTelemetry } from "../telemetry/ledger.js";
import { TELEMETRY_EVENT_NAMES } from "../telemetry/schema.js";
import { runTelemetryCommand } from "./telemetry.js";

const DAY_MS = 24 * 60 * 60_000;

let tempHome: string;

beforeEach(async () => {
  tempHome = await fsp.mkdtemp(path.join(os.tmpdir(), "lisa-cli-telemetry-"));
});

afterEach(async () => {
  await fsp.rm(tempHome, { recursive: true, force: true });
});

function captureIo(nowMs: number, env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
      home: tempHome,
      env,
      now: () => nowMs,
    },
  };
}

describe("parseArgs — telemetry subcommand", () => {
  test("passes telemetry subcommands and flags verbatim", () => {
    const r = parseArgs(["telemetry", "report", "--days", "7", "--json"]);
    assert.equal(r.subcommand, "telemetry");
    assert.deepEqual(r.subargs, ["report", "--days", "7", "--json"]);

    const c = parseArgs(["telemetry", "clear"]);
    assert.equal(c.subcommand, "telemetry");
    assert.deepEqual(c.subargs, ["clear"]);

    const h = parseArgs(["telemetry", "--help"]);
    assert.equal(h.subcommand, "telemetry");
    assert.equal(h.showHelp, false);
    assert.deepEqual(h.subargs, ["--help"]);
  });
});

describe("lisa telemetry CLI", () => {
  test("report [--days N] [--json] filters by window and emits valid JSON", async () => {
    const now = Date.parse("2026-11-20T12:00:00.000Z");
    await trackTelemetry(
      {
        name: "session_started",
        properties: { surface: "cli", resumed: false, sinceBirth: "0" },
      },
      { home: tempHome, now: now - 10 * DAY_MS },
    );
    await trackTelemetry(
      {
        name: "turn_completed",
        properties: {
          surface: "cli",
          tokens: "1-5k",
          toolCalls: "1",
          provider: "anthropic",
          stopReason: "end",
        },
      },
      { home: tempHome, now: now - 1 * DAY_MS },
    );
    await trackTelemetry(
      {
        name: "cli_command_run",
        properties: { command: "status", ok: true, durationMs: "<1s" },
      },
      { home: tempHome, now },
    );

    const textRun = captureIo(now);
    assert.equal(await runTelemetryCommand(["report"], textRun.io), 0);
    const rendered = textRun.out.join("\n");
    assert.match(rendered, /3 event\(s\)/);
    assert.match(rendered, /turn_completed/);

    const jsonRun = captureIo(now);
    assert.equal(await runTelemetryCommand(["report", "--days=7", "--json"], jsonRun.io), 0);
    const payload = JSON.parse(jsonRun.out[0]!) as {
      enabled: boolean;
      days: number;
      remoteUpload: string;
      summary: { totalEvents: number; byEvent: Record<string, number> };
    };
    assert.equal(payload.enabled, true);
    assert.equal(payload.days, 7);
    assert.equal(payload.remoteUpload, "disabled");
    assert.equal(payload.summary.totalEvents, 2);
    assert.equal(payload.summary.byEvent.session_started, undefined);
    assert.equal(payload.summary.byEvent.turn_completed, 1);
    assert.equal(payload.summary.byEvent.cli_command_run, 1);
  });

  test("clear removes the local ledger and reports cleanly when already absent", async () => {
    const now = Date.parse("2026-11-20T12:00:00.000Z");
    await trackTelemetry(
      {
        name: "birth_completed",
        properties: { durationMs: "<1s", provider: "anthropic", tokens: "<1k", retried: false },
      },
      { home: tempHome, now },
    );
    assert.equal(fs.existsSync(telemetryFile(tempHome)), true);

    const c1 = captureIo(now);
    assert.equal(await runTelemetryCommand(["clear", "--json"], c1.io), 0);
    assert.equal(JSON.parse(c1.out[0]!).cleared, true);
    assert.equal(fs.existsSync(telemetryFile(tempHome)), false);

    const c2 = captureIo(now);
    assert.equal(await runTelemetryCommand(["clear"], c2.io), 0);
    assert.match(c2.out[0]!, /No local telemetry ledger/);
  });

  test("status and events reflect opt-out and full schema policy", async () => {
    const now = Date.parse("2026-11-20T12:00:00.000Z");
    const statusRun = captureIo(now, { LISA_TELEMETRY: "off" });
    assert.equal(await runTelemetryCommand(["status", "--json"], statusRun.io), 0);
    const status = JSON.parse(statusRun.out[0]!) as { enabled: boolean; remoteUpload: string };
    assert.equal(status.enabled, false);
    assert.equal(status.remoteUpload, "disabled");

    const eventsRun = captureIo(now);
    assert.equal(await runTelemetryCommand(["events", "--json"], eventsRun.io), 0);
    const listed = JSON.parse(eventsRun.out[0]!) as Array<{ name: string }>;
    assert.equal(listed.length, TELEMETRY_EVENT_NAMES.length);
  });

  test("rejects unknown subcommands and invalid flags with exit code 2", async () => {
    const now = Date.parse("2026-11-20T12:00:00.000Z");
    const badSub = captureIo(now);
    assert.equal(await runTelemetryCommand(["bogus"], badSub.io), 2);
    assert.match(badSub.err.join("\n"), /unknown telemetry subcommand/);

    const badDays = captureIo(now);
    assert.equal(await runTelemetryCommand(["report", "--days", "0"], badDays.io), 2);
    assert.match(badDays.err.join("\n"), /--days must be between/);

    const badFlag = captureIo(now);
    assert.equal(await runTelemetryCommand(["report", "--unknown"], badFlag.io), 2);
    assert.match(badFlag.err.join("\n"), /unknown argument/);
  });

  test("src/cli.ts dispatches `lisa telemetry report --days 7 --json` and `clear` end-to-end", async () => {
    const now = Date.now();
    await trackTelemetry(
      { name: "session_started", properties: { surface: "cli", resumed: false, sinceBirth: "0" } },
      { home: tempHome, now },
    );

    const reportRes = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.resolve("src/cli.ts"),
        "telemetry",
        "report",
        "--days",
        "7",
        "--json",
      ],
      { env: { ...process.env, LISA_HOME: tempHome } },
    );
    const parsed = JSON.parse(reportRes.stdout) as {
      days: number;
      summary: { totalEvents: number };
    };
    assert.equal(parsed.days, 7);
    assert.equal(parsed.summary.totalEvents, 1);

    const clearRes = await execFileAsync(
      process.execPath,
      ["--import", "tsx", path.resolve("src/cli.ts"), "telemetry", "clear", "--json"],
      { env: { ...process.env, LISA_HOME: tempHome } },
    );
    assert.equal(JSON.parse(clearRes.stdout).cleared, true);
    assert.equal(fs.existsSync(telemetryFile(tempHome)), false);
  });
});
