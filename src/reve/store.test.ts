import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { applyRetention, listDreams, dreamIdTime } = await import("./store.js");

let home: string;
const savedHome = process.env.LISA_HOME;
const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-10-09T12:00:00Z");

function idAt(ms: number, n: number): string {
  const iso = new Date(ms).toISOString();
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}${iso.slice(20, 23)}`;
  return `d-${stamp}-${n.toString(16).padStart(8, "0")}`;
}

function fakeDream(id: string, padBytes = 0): void {
  const dir = path.join(home, "reve", "dreams");
  fs.mkdirSync(dir, { recursive: true });
  const rec = {
    version: 1,
    id,
    trigger: "idle",
    windowStart: new Date(dreamIdTime(id)).toISOString(),
    windowEnd: new Date(dreamIdTime(id)).toISOString(),
    autonomyRunIds: [],
    outcome: "done",
    capture: "snapshot",
    soulCommits: [],
    changes: [],
    desires: { added: [], revised: [], closed: [] },
    emotions: null,
    skillsTouched: [],
    metrics: {},
    reconsiderDelivered: [],
    reverts: [],
    summary: "x".repeat(padBytes),
    truncated: false,
  };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(rec));
  fs.writeFileSync(path.join(dir, `${id}.md`), "# d\n");
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-reve-store-"));
  process.env.LISA_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("dream retention", () => {
  test("keeps the newest 60 even when they are older than 90 days", async () => {
    // 70 dreams, one every 10 days → all but the newest 9 are older than 90 days.
    const ids = Array.from({ length: 70 }, (_, i) => idAt(NOW - i * 10 * DAY, i));
    for (const id of ids) fakeDream(id);
    const removed = await applyRetention(NOW);
    assert.equal(removed.length, 10);
    const { dreams } = await listDreams(500);
    assert.equal(dreams.length, 60);
    assert.deepEqual(removed.sort(), ids.slice(60).sort());
  });

  test("keeps everything from the last 90 days even past 60", async () => {
    const ids = Array.from({ length: 100 }, (_, i) => idAt(NOW - i * 12 * 60 * 60_000, i)); // every 12h, ~50 days
    for (const id of ids) fakeDream(id);
    assert.deepEqual(await applyRetention(NOW), []);
    assert.equal((await listDreams(500)).dreams.length, 100);
  });

  test("bounded bytes: prunes oldest first, never below the floor", async () => {
    const ids = Array.from({ length: 30 }, (_, i) => idAt(NOW - i * 60_000, i));
    for (const id of ids) fakeDream(id, 10_000);
    const removed = await applyRetention(NOW, { maxBytes: 100_000, floor: 5 });
    const left = (await listDreams(500)).dreams.map((d) => d.id);
    assert.ok(left.length >= 5 && left.length <= 10, `left ${left.length}`);
    assert.deepEqual(left, ids.slice(0, left.length), "the newest survive");
    assert.equal(removed.length, 30 - left.length);
    const tight = await applyRetention(NOW, { maxBytes: 1, floor: 5 });
    assert.equal((await listDreams(500)).dreams.length, 5);
    assert.ok(tight.length > 0);
  });

  test("removes orphan sidecars whose record never landed", async () => {
    const dir = path.join(home, "reve", "dreams");
    fs.mkdirSync(dir, { recursive: true });
    const orphan = idAt(NOW - DAY, 1);
    fs.writeFileSync(path.join(dir, `${orphan}.before.json`), "{}");
    const fresh = idAt(NOW - 1000, 2);
    fs.writeFileSync(path.join(dir, `${fresh}.before.json`), "{}");
    const removed = await applyRetention(NOW);
    assert.deepEqual(removed, [orphan]);
    assert.ok(
      fs.existsSync(path.join(dir, `${fresh}.before.json`)),
      "a record still being written is kept",
    );
  });
});
