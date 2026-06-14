import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordTakoCall, listTakoCalls, loadTakoLedger } from "./ledger.js";

// LISA_HOME-tmp isolation: the ledger resolves its path lazily (reads LISA_HOME
// at call time), so a per-test tmp dir keeps writes off the real ~/.lisa.
let home: string;
let prev: string | undefined;
beforeEach(() => {
  prev = process.env.LISA_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-tako-"));
  process.env.LISA_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = prev;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("takoapi call ledger", () => {
  test("records a call and lists it", () => {
    recordTakoCall({ slug: "a", state: "completed", now: 1000 });
    const all = listTakoCalls(1000);
    assert.equal(all.length, 1);
    assert.equal(all[0]!.slug, "a");
    assert.equal(all[0]!.lastState, "completed");
  });

  test("upserts by slug (latest call wins), preserving startedAt", () => {
    recordTakoCall({ slug: "a", state: "working", now: 1000 });
    recordTakoCall({ slug: "a", state: "completed", now: 2000 });
    const all = listTakoCalls(2000);
    assert.equal(all.length, 1);
    assert.equal(all[0]!.lastState, "completed");
    assert.equal(all[0]!.startedAt, 1000);
    assert.equal(all[0]!.lastMtime, 2000);
  });

  test("keeps the prior taskId when a later call omits it", () => {
    recordTakoCall({ slug: "a", state: "working", taskId: "t1", now: 1000 });
    recordTakoCall({ slug: "a", state: "completed", now: 2000 });
    assert.equal(loadTakoLedger().find((e) => e.slug === "a")!.taskId, "t1");
  });

  test("separate slugs are separate rows, newest first", () => {
    recordTakoCall({ slug: "a", state: "completed", now: 1000 });
    recordTakoCall({ slug: "b", state: "working", now: 2000 });
    assert.deepEqual(listTakoCalls(2000).map((e) => e.slug), ["b", "a"]);
  });

  test("prunes calls older than the retention window", () => {
    recordTakoCall({ slug: "old", state: "completed", now: 0 });
    const dayPlus = 25 * 60 * 60_000;
    recordTakoCall({ slug: "fresh", state: "completed", now: dayPlus });
    assert.deepEqual(listTakoCalls(dayPlus).map((e) => e.slug), ["fresh"]);
  });

  test("missing or corrupt file → empty, never throws", () => {
    assert.deepEqual(loadTakoLedger(), []);
    fs.writeFileSync(path.join(home, "takoapi-calls.json"), "{ not json");
    assert.deepEqual(loadTakoLedger(), []);
  });
});
