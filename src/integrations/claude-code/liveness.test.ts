import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveClaudeSessionIds, pidAlive } from "./liveness.js";

const DEAD_PID = 2147483646; // absurdly high → no such process

test("pidAlive: self is alive, absurd/invalid pids are not", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(DEAD_PID), false);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive(0), false);
});

test("liveClaudeSessionIds returns only sessions whose pid is alive", () => {
  const home = mkdtempSync(join(tmpdir(), "lisa-live-"));
  const dir = join(home, ".claude", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, process.pid + ".json"), JSON.stringify({ pid: process.pid, sessionId: "live-1" }));
  writeFileSync(join(dir, "9999999.json"), JSON.stringify({ pid: DEAD_PID, sessionId: "dead-1" }));
  writeFileSync(join(dir, "garbage.json"), "{ not json");
  writeFileSync(join(dir, "ignored.txt"), JSON.stringify({ pid: process.pid, sessionId: "not-json-ext" }));
  try {
    const live = liveClaudeSessionIds(home);
    assert.equal(live.has("live-1"), true);
    assert.equal(live.has("dead-1"), false);
    assert.equal(live.has("not-json-ext"), false); // non-.json files are skipped
    assert.equal(live.size, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("liveClaudeSessionIds is empty when the sessions dir is absent", () => {
  const home = mkdtempSync(join(tmpdir(), "lisa-live-empty-"));
  try {
    assert.equal(liveClaudeSessionIds(home).size, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
