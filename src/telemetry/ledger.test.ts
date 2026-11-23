import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { homeScope } from "../paths.js";
import {
  clearTelemetryLedger,
  isTelemetryEnabled,
  pruneOlderThanDays,
  readTelemetryEvents,
  summarizeTelemetry,
  telemetryDir,
  telemetryFile,
  trackTelemetry,
} from "./ledger.js";
import { countBucket, dayBucket, msBucket, tokBucket, type TelemetryEvent } from "./schema.js";

const TELEMETRY_DIR = path.dirname(fileURLToPath(import.meta.url));
const DAY_MS = 24 * 60 * 60_000;

let tempHome: string;
let prevHome: string | undefined;
let prevTelemetry: string | undefined;
let prevTelemetryLocal: string | undefined;

beforeEach(async () => {
  prevHome = process.env.LISA_HOME;
  prevTelemetry = process.env.LISA_TELEMETRY;
  prevTelemetryLocal = process.env.LISA_TELEMETRY_LOCAL;
  tempHome = await fsp.mkdtemp(path.join(os.tmpdir(), "lisa-telemetry-"));
  process.env.LISA_HOME = tempHome;
  delete process.env.LISA_TELEMETRY;
  delete process.env.LISA_TELEMETRY_LOCAL;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = prevHome;
  if (prevTelemetry === undefined) delete process.env.LISA_TELEMETRY;
  else process.env.LISA_TELEMETRY = prevTelemetry;
  if (prevTelemetryLocal === undefined) delete process.env.LISA_TELEMETRY_LOCAL;
  else process.env.LISA_TELEMETRY_LOCAL = prevTelemetryLocal;
  await fsp.rm(tempHome, { recursive: true, force: true });
});

function findEgressViolations(source: string): string[] {
  const hits: string[] = [];
  const forbiddenImports = [
    /from\s+["']node:(?:http|https|http2|net|tls|dgram|dns)["']/,
    /from\s+["'](?:http|https|http2|net|tls|dgram|dns|undici|ws|node-fetch|axios|got)["']/,
    /import\(["'](?:node:)?(?:http|https|http2|net|tls|dgram|dns|undici|ws)["']\)/,
  ];
  const forbiddenCalls = [
    /\bfetch\s*\(/,
    /\bnew\s+WebSocket\s*\(/,
    /\bnew\s+XMLHttpRequest\s*\(/,
    /\bnew\s+EventSource\s*\(/,
    /\bsendBeacon\s*\(/,
    /\b(?:http|https|net|tls)\.(?:request|get|connect|createConnection)\s*\(/,
  ];
  for (const re of [...forbiddenImports, ...forbiddenCalls]) {
    if (re.test(source)) hits.push(re.source);
  }
  return hits;
}

describe("telemetry ledger — storage, permissions, opt-out, and tenant isolation", () => {
  test("writes valid events to <lisaHome>/telemetry/events.jsonl with mode 0600", async () => {
    const fixedNow = Date.parse("2026-11-20T12:00:00.000Z");
    const ok = await trackTelemetry(
      {
        name: "birth_completed",
        properties: {
          durationMs: msBucket(4_200),
          provider: "anthropic",
          tokens: tokBucket(12_000),
          retried: false,
        },
      },
      { now: fixedNow },
    );
    assert.equal(ok, true);

    const file = telemetryFile();
    assert.equal(file, path.join(tempHome, "telemetry", "events.jsonl"));
    if (process.platform !== "win32") {
      assert.equal((await fsp.stat(telemetryDir())).mode & 0o777, 0o700);
      assert.equal((await fsp.stat(file)).mode & 0o777, 0o600);
    }

    const events = await readTelemetryEvents({ now: fixedNow });
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      v: 1,
      name: "birth_completed",
      occurredAt: "2026-11-20T12:00:00.000Z",
      properties: {
        durationMs: "1-5s",
        provider: "anthropic",
        tokens: "5-20k",
        retried: false,
      },
    });
  });

  test("honors LISA_TELEMETRY=off and LISA_TELEMETRY_LOCAL=0 without creating files", async () => {
    for (const env of [
      { LISA_TELEMETRY: "off" },
      { LISA_TELEMETRY: "OFF" },
      { LISA_TELEMETRY: "0" },
      { LISA_TELEMETRY: "false" },
      { LISA_TELEMETRY_LOCAL: "0" },
    ]) {
      assert.equal(isTelemetryEnabled(env), false);
      const ok = await trackTelemetry(
        {
          name: "session_started",
          properties: { surface: "cli", resumed: false, sinceBirth: dayBucket(0) },
        },
        { env },
      );
      assert.equal(ok, false);
      assert.equal(fs.existsSync(telemetryDir()), false);
    }
  });

  test("concurrent writes remain serialized and intact without torn JSONL lines", async () => {
    const baseNow = Date.parse("2026-11-20T12:00:00.000Z");
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        trackTelemetry(
          {
            name: "cli_command_run",
            properties: {
              command: "status",
              ok: i % 2 === 0,
              durationMs: msBucket(100 + i * 50),
            },
          },
          { now: baseNow + i },
        ),
      ),
    );
    assert.ok(results.every(Boolean));
    const events = await readTelemetryEvents({ now: baseNow + 100 });
    assert.equal(events.length, 20);
  });

  test("isolates tenants across concurrent homeScope contexts", async () => {
    const uidA = "user-alpha";
    const uidB = "user-beta";
    const homeA = path.join(tempHome, "users", uidA);
    const homeB = path.join(tempHome, "users", uidB);
    const fixedNow = Date.parse("2026-11-20T12:00:00.000Z");

    await Promise.all([
      homeScope.run(homeA, () =>
        trackTelemetry(
          {
            name: "session_started",
            properties: { surface: "web", resumed: false, sinceBirth: "0" },
          },
          { now: fixedNow },
        ),
      ),
      homeScope.run(homeB, () =>
        trackTelemetry(
          {
            name: "task_created",
            properties: {
              kind: "routine",
              hasSchedule: true,
              hasTrigger: false,
              hasEnvelope: true,
            },
          },
          { now: fixedNow },
        ),
      ),
    ]);

    const eventsA = await homeScope.run(homeA, () => readTelemetryEvents({ now: fixedNow }));
    const eventsB = await homeScope.run(homeB, () => readTelemetryEvents({ now: fixedNow }));
    assert.deepEqual(
      eventsA.map((e) => e.name),
      ["session_started"],
    );
    assert.deepEqual(
      eventsB.map((e) => e.name),
      ["task_created"],
    );
  });

  test("enforces fail-closed edition and policy rules on trackTelemetry", async () => {
    const fixedNow = Date.parse("2026-11-20T12:00:00.000Z");
    assert.equal(
      await trackTelemetry(
        { name: "free_window_opened", properties: { tier: "free" } },
        { edition: "mac", now: fixedNow },
      ),
      false,
    );
    assert.equal(
      await trackTelemetry(
        { name: "free_window_opened", properties: { tier: "free" } },
        { edition: "cloud", now: fixedNow },
      ),
      true,
    );
    assert.equal(
      await trackTelemetry(
        {
          name: "birth_completed",
          properties: { durationMs: "<1s", provider: "anthropic", tokens: "<1k", retried: false },
        },
        { edition: "cloud", now: fixedNow },
      ),
      false,
    );
    assert.equal(
      await trackTelemetry(
        { name: "undeclared_event", properties: {} } as unknown as TelemetryEvent,
        {
          now: fixedNow,
        },
      ),
      false,
    );
  });
});

describe("telemetry ledger — planted-secret absence, retention pruning, and resilience", () => {
  test("never persists planted secrets, prompts, replies, paths, repos, or URLs", async () => {
    const plantedSecrets = [
      "sk-ant-api03-PLANTED_API_KEY_998877",
      "PLANTED_USER_PROMPT_PRIVATE_THOUGHT",
      "PLANTED_ASSISTANT_REPLY_CONTENT",
      "/Users/alice/secret-employer-project",
      "acme-corp/unreleased-monorepo",
      "https://user:PLANTED_PASS@internal.acme.local/hook",
      "alice@secret-company.example",
    ];
    const fixedNow = Date.parse("2026-11-20T12:00:00.000Z");

    // 1) Valid event carrying extra sensitive keys -> extras are redacted/stripped.
    const ok = await trackTelemetry(
      {
        name: "connector_authorized",
        properties: {
          provider: "github",
          authMode: "login",
          ok: true,
          prompt: plantedSecrets[1],
          reply: plantedSecrets[2],
          cwd: plantedSecrets[3],
          repo: plantedSecrets[4],
          url: plantedSecrets[5],
          email: plantedSecrets[6],
          token: plantedSecrets[0],
        },
      } as unknown as TelemetryEvent,
      { now: fixedNow },
    );
    assert.equal(ok, true);

    // 2) Planted secret smuggled inside a declared field -> entire event rejected fail-closed.
    const rejected = await trackTelemetry(
      {
        name: "cli_command_run",
        properties: {
          command: plantedSecrets[0],
          ok: true,
          durationMs: "<1s",
        },
      } as unknown as TelemetryEvent,
      { now: fixedNow },
    );
    assert.equal(rejected, false);

    const diskContent = await fsp.readFile(telemetryFile(), "utf8");
    for (const secret of plantedSecrets) {
      assert.equal(diskContent.includes(secret), false, `planted secret leaked to disk: ${secret}`);
    }
    const events = await readTelemetryEvents({ now: fixedNow });
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]!.properties, {
      provider: "github",
      authMode: "login",
      ok: true,
    });
  });

  test("enforces 30-day automatic pruning on write and via pruneOlderThanDays", async () => {
    const now = Date.parse("2026-11-20T12:00:00.000Z");
    const stale35d = new Date(now - 35 * DAY_MS).toISOString();
    const stale30dPlus1s = new Date(now - 30 * DAY_MS - 1_000).toISOString();
    const fresh29d = new Date(now - 29 * DAY_MS).toISOString();

    await fsp.mkdir(telemetryDir(), { recursive: true, mode: 0o700 });
    const seedLines = [
      JSON.stringify({
        v: 1,
        name: "session_started",
        occurredAt: stale35d,
        properties: { surface: "cli", resumed: false, sinceBirth: "0" },
      }),
      JSON.stringify({
        v: 1,
        name: "session_started",
        occurredAt: stale30dPlus1s,
        properties: { surface: "cli", resumed: true, sinceBirth: "1" },
      }),
      JSON.stringify({
        v: 1,
        name: "session_started",
        occurredAt: fresh29d,
        properties: { surface: "web", resumed: false, sinceBirth: "2-6" },
      }),
    ];
    await fsp.writeFile(telemetryFile(), seedLines.join("\n") + "\n", { mode: 0o600 });

    const pruned = await pruneOlderThanDays(30, { now });
    assert.deepEqual(pruned, { removed: 2, kept: 1 });

    // Writing a new event also automatically prunes stale entries.
    await fsp.appendFile(
      telemetryFile(),
      JSON.stringify({
        v: 1,
        name: "task_created",
        occurredAt: stale35d,
        properties: { kind: "oneoff", hasSchedule: false, hasTrigger: false, hasEnvelope: false },
      }) + "\n",
    );

    const tracked = await trackTelemetry(
      {
        name: "turn_completed",
        properties: {
          surface: "cli",
          tokens: tokBucket(1500),
          toolCalls: countBucket(1),
          provider: "openai",
          stopReason: "end",
        },
      },
      { now },
    );
    assert.equal(tracked, true);

    const kept = await readTelemetryEvents({ now });
    assert.deepEqual(
      kept.map((e) => e.name),
      ["session_started", "turn_completed"],
    );

    // pruneOlderThanDays(0) clears all existing records cleanly.
    const cleared = await pruneOlderThanDays(0, { now });
    assert.deepEqual(cleared, { removed: 2, kept: 0 });
    assert.deepEqual(await readTelemetryEvents({ now }), []);
  });

  test("enforces maxLines cap keeping the newest records", async () => {
    const baseNow = Date.parse("2026-11-20T12:00:00.000Z");
    for (let i = 0; i < 6; i++) {
      await trackTelemetry(
        {
          name: "cli_command_run",
          properties: { command: "status", ok: true, durationMs: "<1s" },
        },
        { now: baseNow + i * 1_000, maxLines: 3 },
      );
    }
    const events = await readTelemetryEvents({ now: baseNow + 10_000 });
    assert.equal(events.length, 3);
    assert.equal(events[0]!.occurredAt, new Date(baseNow + 3_000).toISOString());
    assert.equal(events[2]!.occurredAt, new Date(baseNow + 5_000).toISOString());
  });

  test("survives corrupted lines and unwritable storage without throwing", async () => {
    const now = Date.parse("2026-11-20T12:00:00.000Z");
    await fsp.mkdir(telemetryDir(), { recursive: true, mode: 0o700 });
    const lines = [
      "",
      "{broken json",
      "null",
      "123",
      JSON.stringify({
        v: 99,
        name: "session_started",
        occurredAt: new Date(now).toISOString(),
        properties: {},
      }),
      JSON.stringify({
        v: 1,
        name: "unknown_event",
        occurredAt: new Date(now).toISOString(),
        properties: {},
      }),
      JSON.stringify({
        v: 1,
        name: "session_started",
        occurredAt: "not-a-timestamp",
        properties: { surface: "cli", resumed: false, sinceBirth: "0" },
      }),
      JSON.stringify({
        v: 1,
        name: "cli_command_run",
        occurredAt: new Date(now).toISOString(),
        properties: { command: "rm -rf /", ok: true, durationMs: "<1s" },
      }),
      JSON.stringify({
        v: 1,
        name: "approval_decided",
        occurredAt: new Date(now).toISOString(),
        properties: {
          category: "exec",
          verdict: "approved",
          scope: "once",
          surface: "web",
          tainted: false,
          secret: "SHOULD_BE_STRIPPED",
        },
      }),
    ];
    await fsp.writeFile(telemetryFile(), lines.join("\n") + "\n", { mode: 0o600 });

    const readBack = await readTelemetryEvents({ now });
    assert.equal(readBack.length, 1);
    assert.equal(readBack[0]!.name, "approval_decided");
    assert.equal("secret" in readBack[0]!.properties, false);

    // Unwritable target: place a regular file where the telemetry directory would be.
    const badHome = await fsp.mkdtemp(path.join(os.tmpdir(), "lisa-telemetry-bad-"));
    try {
      await fsp.writeFile(path.join(badHome, "telemetry"), "not-a-directory");
      const ok = await trackTelemetry(
        {
          name: "session_started",
          properties: { surface: "cli", resumed: false, sinceBirth: "0" },
        },
        { home: badHome, now },
      );
      assert.equal(ok, false);
    } finally {
      await fsp.rm(badHome, { recursive: true, force: true });
    }
  });

  test("summarizeTelemetry aggregates counts and clearTelemetryLedger deletes ledger", async () => {
    const now = Date.parse("2026-11-20T12:00:00.000Z");
    assert.equal(summarizeTelemetry([]).totalEvents, 0);
    assert.equal(await clearTelemetryLedger(), false);

    await trackTelemetry(
      { name: "session_started", properties: { surface: "cli", resumed: false, sinceBirth: "0" } },
      { now: now - DAY_MS },
    );
    await trackTelemetry(
      {
        name: "turn_completed",
        properties: {
          surface: "cli",
          tokens: "1-5k",
          toolCalls: "2-3",
          provider: "anthropic",
          stopReason: "end",
        },
      },
      { now },
    );
    await trackTelemetry(
      {
        name: "task_run_finished",
        properties: { kind: "routine", outcome: "succeeded", durationMs: "5-30s", tokens: "1-5k" },
      },
      { now },
    );
    await trackTelemetry(
      {
        name: "approval_decided",
        properties: {
          category: "write",
          verdict: "approved",
          scope: "once",
          surface: "web",
          tainted: false,
        },
      },
      { now },
    );
    await trackTelemetry(
      {
        name: "connector_authorized",
        properties: { provider: "github", authMode: "login", ok: true },
      },
      { now },
    );
    await trackTelemetry(
      {
        name: "cli_command_run",
        properties: { command: "doctor", ok: false, durationMs: "<1s" },
      },
      { now },
    );

    const events = await readTelemetryEvents({ now });
    const summary = summarizeTelemetry(events);
    assert.equal(summary.totalEvents, 6);
    assert.equal(summary.sessions.started, 1);
    assert.equal(summary.sessions.bySurface.cli, 1);
    assert.equal(summary.turns.completed, 1);
    assert.equal(summary.turns.byProvider.anthropic, 1);
    assert.equal(summary.tasks.finished, 1);
    assert.equal(summary.tasks.byOutcome.succeeded, 1);
    assert.equal(summary.approvals.decided, 1);
    assert.equal(summary.approvals.byVerdict.approved, 1);
    assert.equal(summary.connectors.succeeded, 1);
    assert.equal(summary.cli.commandsRun, 1);
    assert.equal(summary.cli.failed, 1);
    assert.deepEqual(summary.byDay, { "2026-11-19": 1, "2026-11-20": 5 });

    assert.equal(await clearTelemetryLedger(), true);
    assert.equal(fs.existsSync(telemetryFile()), false);
    assert.equal(await clearTelemetryLedger(), false);
  });
});

describe("zero-egress source-scan guard on src/telemetry/", () => {
  test("guard is non-vacuous and catches synthetic egress calls", () => {
    assert.ok(findEgressViolations('await fetch("https://example.com");').length > 0);
    assert.ok(findEgressViolations('import https from "node:https";').length > 0);
    assert.ok(findEgressViolations('import { request } from "undici";').length > 0);
    assert.deepEqual(findEgressViolations('import fs from "node:fs/promises";'), []);
  });

  test("no shipped source file in src/telemetry/ imports or calls network egress APIs", async () => {
    const entries = await fsp.readdir(TELEMETRY_DIR, { withFileTypes: true });
    const sourceFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
      .map((e) => path.join(TELEMETRY_DIR, e.name));

    const cliTelemetryFile = path.resolve(TELEMETRY_DIR, "..", "cli", "telemetry.ts");
    assert.ok(sourceFiles.length >= 2, "expected schema.ts and ledger.ts in src/telemetry/");
    for (const file of [...sourceFiles, cliTelemetryFile]) {
      const content = await fsp.readFile(file, "utf8");
      const violations = findEgressViolations(content);
      assert.deepEqual(
        violations,
        [],
        `${path.basename(file)} must have zero network egress, found: ${violations.join(", ")}`,
      );
    }
  });
});
