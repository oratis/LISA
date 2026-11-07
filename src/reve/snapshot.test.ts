import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LISA_KB_NO_GIT = "1";
process.env.LISA_SOUL_GIT = "0";

const { takeSnapshot, sha256, MAX_SNAPSHOT_FILE_BYTES } = await import("./snapshot.js");
const { withDream } = await import("./record.js");
const { listDreams, readDream } = await import("./store.js");
const { appendMemory } = await import("../memory/store.js");

let home: string;
const savedHome = process.env.LISA_HOME;

const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
  fs.writeFileSync(path.join(home, rel), text);
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-reve-snapshot-"));
  process.env.LISA_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("snapshot reads are bounded (#423 review P2)", () => {
  test("a file over the per-file cap is hashed from a stream, not kept", async () => {
    // 3-byte characters, so 64 KiB read chunks split characters.
    const big = "€".repeat(Math.ceil((MAX_SNAPSHOT_FILE_BYTES + 10_000) / 3)) + "\nend\n";
    const small = "# Rust\n\nA systems language. €\n";
    write("kb/sources/big.md", big);
    write("kb/wiki/rust.md", small);
    const snap = await takeSnapshot(["kb"]);
    const b = snap.files.get("kb/sources/big.md");
    assert.ok(b);
    assert.equal(b.content, undefined, "content past the cap is never held");
    assert.equal(b.hash, sha256(big), "same hash as a whole read would give");
    assert.equal(b.bytes, Buffer.byteLength(big, "utf8"));
    assert.equal(snap.capped, true);
    const s = snap.files.get("kb/wiki/rust.md");
    assert.equal(s?.content, small);
    assert.equal(s?.hash, sha256(small));
  });

  test("an unchanged big file is not reported as changed", async () => {
    write("kb/sources/big.md", "x".repeat(MAX_SNAPSHOT_FILE_BYTES * 2));
    write("memory/MEMORY.md", "- tea\n");
    await withDream({ trigger: "idle" }, () => appendMemory("memory", "coffee"));
    const { dreams } = await listDreams(1);
    const rec = await readDream(dreams[0]!.id);
    assert.deepEqual(
      rec.changes.map((c) => c.path),
      ["memory/MEMORY.md"],
    );
  });
});
