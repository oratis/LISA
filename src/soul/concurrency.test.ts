import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// R3 (PLAN_REVE) end-to-end: lock.test.ts proves the lock PRIMITIVE is mutually
// exclusive; this proves the real soul read-modify-write (applyEmotionDelta:
// read emotions → append an event → persist, under withSoulLock) loses NO append
// under concurrency. Without the lock, concurrent RMW would clobber the events
// array (last-writer-wins) and drop events.
//
// SOUL_DIR derives from LISA_HOME at import, so set a tmp home before importing
// (dynamic import); node --test isolates each file in its own process.
let store: typeof import("./store.js");
let home: string;
before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-soul-conc-"));
  process.env.LISA_HOME = home;
  store = await import("./store.js");
  await store.ensureSoulDirs();
});
after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("soul lock — concurrent writes lose no entry (R3)", () => {
  test("N concurrent applyEmotionDelta calls all land (no lost append)", async () => {
    const N = 25;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.applyEmotionDelta({
          emotion: "curiosity",
          delta: 0.01,
          trigger: `t${i}`,
          maxEvents: 1000,
        }),
      ),
    );
    const state = await store.readEmotions();
    assert.equal(state.events?.length, N, "every concurrent append survived the read-modify-write");
    // Distinct triggers ⇒ no event was overwritten by a racing writer.
    const triggers = new Set((state.events ?? []).map((e) => e.trigger));
    assert.equal(triggers.size, N, "all N distinct events present");
  });

  test("maxEvents cap still holds under concurrency (bounded, newest kept)", async () => {
    // Reset to a clean emotions file for this case.
    fs.rmSync(path.join(home, "soul", "emotions.json"), { force: true });
    const N = 30;
    const CAP = 10;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.applyEmotionDelta({ emotion: "focus", delta: 0.001, trigger: `c${i}`, maxEvents: CAP }),
      ),
    );
    const state = await store.readEmotions();
    assert.equal(state.events?.length, CAP, "events stay capped under concurrency (no unbounded growth, no loss of the cap invariant)");
  });
});
