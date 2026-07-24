import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startBirthOnce, birthRunFor, resetBirthRuns } from "./birth-hub.js";
import type { BirthLog } from "../soul/birth.js";

beforeEach(() => {
  resetBirthRuns();
});

describe("birth hub (S3)", () => {
  test("two starters share ONE run — the exec fires once", async () => {
    let execs = 0;
    const exec = async (emit: (l: BirthLog) => void) => {
      execs++;
      emit({ step: "seed", detail: "rolling" });
      emit({ step: "done", detail: "alive" });
    };
    const a = startBirthOnce("u1", exec);
    const b = startBirthOnce("u1", exec);
    assert.equal(a, b);
    await a.promise;
    assert.equal(execs, 1);
  });

  test("a late watcher can replay the transcript then stream live", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const run = startBirthOnce("u2", async (emit) => {
      emit({ step: "seed", detail: "rolling" });
      await gate;
      emit({ step: "done", detail: "alive" });
    });
    // late watcher: replays what already happened…
    await new Promise((r) => setTimeout(r, 10));
    const seen: string[] = run.steps.map((s) => s.step);
    assert.deepEqual(seen, ["seed"]);
    // …then subscribes for the rest
    run.listeners.add((l) => seen.push(l.step));
    release();
    await run.promise;
    assert.deepEqual(seen, ["seed", "done"]);
  });

  test("different keys run independently", async () => {
    let execs = 0;
    const exec = async () => {
      execs++;
    };
    await startBirthOnce("a", exec).promise;
    await startBirthOnce("b", exec).promise;
    assert.equal(execs, 2);
  });

  test("a FAILED run clears itself so the next call retries", async () => {
    const bad = startBirthOnce("u3", async () => {
      throw new Error("dream failed");
    });
    await assert.rejects(bad.promise, /dream failed/);
    // settled runs are removed (success is guarded by isBorn, not the hub)
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(birthRunFor("u3"), null);
    let ok = false;
    await startBirthOnce("u3", async () => {
      ok = true;
    }).promise;
    assert.equal(ok, true);
  });

  test("a throwing listener never kills the birth", async () => {
    const run = startBirthOnce("u4", async (emit) => {
      emit({ step: "seed", detail: "x" });
    });
    run.listeners.add(() => {
      throw new Error("broken watcher");
    });
    await run.promise; // resolves fine
  });
});
