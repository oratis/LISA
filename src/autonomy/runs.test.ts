import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate the ledger to a throwaway dir. paths.ts captures LISA_HOME at import
// time, so set it BEFORE the first import of the module under test.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-autonomy-"));
process.env.LISA_HOME = TMP;
const RUNS_FILE = path.join(TMP, "autonomy", "runs.jsonl");

const { recordAutonomyRun, readAutonomyRuns, summarizeAutonomyRuns } = await import("./runs.js");

function run(overrides: Record<string, unknown> = {}) {
  return {
    kind: "idle" as const,
    startedAt: new Date().toISOString(),
    durationMs: 1000,
    inputTokens: 100,
    outputTokens: 50,
    outcome: "done" as const,
    ...overrides,
  };
}

beforeEach(() => {
  fs.rmSync(RUNS_FILE, { force: true });
});

describe("recordAutonomyRun / readAutonomyRuns", () => {
  test("round-trips records in order", async () => {
    await recordAutonomyRun(run({ kind: "idle", outcome: "no-update" }));
    await recordAutonomyRun(run({ kind: "heartbeat", task: "morning", outcome: "done" }));
    const all = await readAutonomyRuns();
    assert.equal(all.length, 2);
    assert.equal(all[0]!.kind, "idle");
    assert.equal(all[1]!.task, "morning");
  });

  test("missing file → empty array (no throw)", async () => {
    assert.deepEqual(await readAutonomyRuns(), []);
  });

  test("skips malformed lines instead of failing the whole read", async () => {
    await recordAutonomyRun(run());
    fs.appendFileSync(RUNS_FILE, "{not json\n");
    await recordAutonomyRun(run({ kind: "reflect" }));
    const all = await readAutonomyRuns();
    assert.equal(all.length, 2, "two good records survive the corrupt middle line");
  });

  test("sinceMs filters out old records", async () => {
    const old = new Date(Date.now() - 10 * 24 * 60 * 60_000).toISOString();
    await recordAutonomyRun(run({ startedAt: old }));
    await recordAutonomyRun(run()); // now
    const recent = await readAutonomyRuns(24 * 60 * 60_000); // last 1 day
    assert.equal(recent.length, 1);
  });
});

describe("summarizeAutonomyRuns", () => {
  test("empty → friendly message", () => {
    assert.match(summarizeAutonomyRuns([]), /No autonomy runs/);
  });

  test("tallies kinds, outcomes, and tokens", () => {
    const out = summarizeAutonomyRuns([
      run({ kind: "idle", outcome: "no-update", inputTokens: 100, outputTokens: 100 }),
      run({ kind: "idle", outcome: "blocked", inputTokens: 200, outputTokens: 0 }),
      run({ kind: "heartbeat", outcome: "done", inputTokens: 0, outputTokens: 100 }),
    ]);
    assert.match(out, /3 total/);
    assert.match(out, /idle 2/);
    assert.match(out, /blocked 1/);
    assert.match(out, /heartbeat 1/);
  });
});
