import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// PLAN_DESIRE_EVOLUTION_v1.0 §3 PR2: reflection (and the desire_close tool) can
// now evolve desires in place, not just append. These exercise the store
// primitives that power both paths.
//
// SOUL_DIR derives from LISA_HOME at import, so set a tmp home before importing
// (dynamic import); node --test isolates each file in its own process.
let store: typeof import("./store.js");
let home: string;

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-desire-evolve-"));
  process.env.LISA_HOME = home;
  store = await import("./store.js");
  await store.ensureSoulDirs();
});
after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

async function seed(slug: string, over: Partial<Parameters<typeof store.writeDesire>[0]> = {}) {
  await store.writeDesire({
    slug,
    what: "learn rust",
    why: "systems fluency",
    actionable: false,
    bornAt: "2026-01-01T00:00:00.000Z",
    ...over,
  });
}

describe("reviseDesire", () => {
  test("changes only the supplied fields; preserves the rest and identity", async () => {
    await seed("revise-partial");
    const next = await store.reviseDesire("revise-partial", { what: "learn zig" });
    assert.equal(next.what, "learn zig");
    assert.equal(next.why, "systems fluency", "why preserved");
    assert.equal(next.actionable, false, "actionable preserved");
    assert.equal(next.slug, "revise-partial", "slug is identity");
    assert.equal(next.bornAt, "2026-01-01T00:00:00.000Z", "bornAt is identity, never moves");

    // And it round-trips through the filesystem, not just the return value.
    const onDisk = (await store.listDesires()).find((d) => d.slug === "revise-partial");
    assert.equal(onDisk?.what, "learn zig");
    assert.equal(onDisk?.why, "systems fluency");
  });

  test("an undefined field in the patch never wipes the existing value", async () => {
    await seed("revise-undefined", { why: "keep me" });
    const next = await store.reviseDesire("revise-undefined", {
      what: "new what",
      why: undefined,
    });
    assert.equal(next.why, "keep me");
  });

  test("can flip a dormant desire to actionable with a heartbeat prompt", async () => {
    await seed("revise-activate");
    const next = await store.reviseDesire("revise-activate", {
      actionable: true,
      heartbeatPrompt: "read one rust chapter",
    });
    assert.equal(next.actionable, true);
    assert.equal(next.heartbeatPrompt, "read one rust chapter");
    assert.equal(store.isAutoPursuable(next), true, "now auto-pursuable by the heartbeat");
  });

  test("throws on an unknown slug (a revise must target something real)", async () => {
    await assert.rejects(
      () => store.reviseDesire("does-not-exist", { what: "x" }),
      /not found/,
    );
  });
});

describe("closeDesire", () => {
  test("soft-closes: actionable=false, [CLOSED] progress note, file retained", async () => {
    await seed("close-me", { actionable: true, heartbeatPrompt: "do the thing" });
    await store.closeDesire("close-me", "fulfilled", "got what I was after");

    const onDisk = (await store.listDesires()).find((d) => d.slug === "close-me");
    assert.ok(onDisk, "the desire file is retained, not deleted");
    assert.equal(onDisk?.actionable, false, "no longer drives the heartbeat");

    const progress = await store.readDesireProgress("close-me");
    assert.match(progress, /\[CLOSED:fulfilled\] got what I was after/);
  });

  test("writes a [DESIRE_CLOSED] journal line so weekly_examen sees it", async () => {
    await seed("close-journal", { actionable: true });
    await store.closeDesire("close-journal", "abandoned", "no longer fits me");
    const today = new Date().toISOString().slice(0, 10);
    const journal = await store.readJournal(today);
    assert.match(journal, /\[DESIRE_CLOSED\] close-journal \(abandoned\): no longer fits me/);
  });

  test("marks closed:true and keeps heartbeatPrompt for a later re-open", async () => {
    await seed("close-mark", { actionable: true, heartbeatPrompt: "ping it" });
    await store.closeDesire("close-mark", "fulfilled", "done");
    const onDisk = (await store.listDesires()).find((d) => d.slug === "close-mark");
    assert.equal(onDisk?.closed, true, "distinct closed marker, not just actionable:false");
    assert.equal(onDisk?.actionable, false);
    assert.equal(
      onDisk?.heartbeatPrompt,
      "ping it",
      "heartbeatPrompt retained so re-open restores auto-pursuit",
    );
  });

  test("re-closing an already-closed desire is idempotent (no duplicate notes)", async () => {
    await seed("close-twice", { actionable: true });
    await store.closeDesire("close-twice", "fulfilled", "first");
    await store.closeDesire("close-twice", "fulfilled", "second"); // guarded no-op
    const progress = await store.readDesireProgress("close-twice");
    const journal = await store.readJournal(new Date().toISOString().slice(0, 10));
    assert.equal((progress.match(/\[CLOSED:/g) ?? []).length, 1, "one [CLOSED] progress note");
    assert.equal(
      (journal.match(/\[DESIRE_CLOSED\] close-twice/g) ?? []).length,
      1,
      "one [DESIRE_CLOSED] journal line",
    );
  });

  test("reviseDesire re-opens a closed desire — clears closed, restores actionable", async () => {
    await seed("reopen-me", { actionable: true, heartbeatPrompt: "keep pinging" });
    await store.closeDesire("reopen-me", "abandoned", "then reconsidered");
    await store.reviseDesire("reopen-me", { actionable: true });
    const onDisk = (await store.listDesires()).find((d) => d.slug === "reopen-me");
    assert.equal(onDisk?.closed ?? false, false, "re-opening clears the closed flag");
    assert.equal(onDisk?.actionable, true);
    assert.equal(onDisk?.heartbeatPrompt, "keep pinging", "auto-pursuit restored on re-open");
  });

  test("throws on an unknown slug", async () => {
    await assert.rejects(
      () => store.closeDesire("ghost", "fulfilled", "x"),
      /not found/,
    );
  });
});
