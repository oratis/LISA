import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Embedder } from "./embedding.js";

// Isolate the on-disk cache before importing the module (paths.js reads
// lisaHome() at import time).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-embcache-"));
process.env.LISA_HOME = TMP;

const { docHash, embedWithCache, loadEmbeddingCache, saveEmbeddingCache } = await import("./embedding.js");

function countingEmbedder(): { e: Embedder; calls: () => number } {
  let n = 0;
  const e: Embedder = {
    id: "fake-embedder",
    async embed(texts) {
      n += texts.length;
      return texts.map((t) => [t.length]); // vector derived from content, deterministic
    },
  };
  return { e, calls: () => n };
}

describe("docHash", () => {
  test("deterministic and content-sensitive", () => {
    assert.equal(docHash("hello"), docHash("hello"));
    assert.notEqual(docHash("hello"), docHash("hellp"));
  });
});

describe("embedWithCache", () => {
  test("first pass embeds all; second pass is a full cache hit (no new calls)", async () => {
    const { e, calls } = countingEmbedder();
    const r1 = await embedWithCache(["aa", "bbb"], e, {});
    assert.equal(r1.misses, 2);
    assert.equal(calls(), 2);
    assert.deepEqual(r1.vectors, [[2], [3]]);

    const r2 = await embedWithCache(["aa", "bbb"], e, r1.updated);
    assert.equal(r2.misses, 0);
    assert.equal(calls(), 2, "no further embed calls on a full hit");
    assert.deepEqual(r2.vectors, [[2], [3]]);
  });

  test("only changed docs re-embed", async () => {
    const { e, calls } = countingEmbedder();
    const r1 = await embedWithCache(["aa", "bbb"], e, {});
    const before = calls();
    const r3 = await embedWithCache(["aa", "CHANGED"], e, r1.updated);
    assert.equal(r3.misses, 1);
    assert.equal(calls(), before + 1, "only the changed doc is embedded");
  });

  test("updated cache is pruned to the current doc set", async () => {
    const { e } = countingEmbedder();
    const r1 = await embedWithCache(["aa", "bbb"], e, {});
    const r4 = await embedWithCache(["aa"], e, r1.updated); // "bbb" dropped
    assert.equal(Object.keys(r4.updated).length, 1);
    assert.ok(r4.updated[docHash("aa")]);
  });

  test("does not mutate the input cache", async () => {
    const { e } = countingEmbedder();
    const cache = {};
    await embedWithCache(["aa"], e, cache);
    assert.deepEqual(cache, {});
  });
});

describe("load/saveEmbeddingCache (disk)", () => {
  test("round-trips, sanitizing the embedder id into a filename", async () => {
    await saveEmbeddingCache("ollama:nomic-embed-text", { [docHash("x")]: [1, 2, 3] });
    const loaded = await loadEmbeddingCache("ollama:nomic-embed-text");
    assert.deepEqual(loaded[docHash("x")], [1, 2, 3]);
  });
  test("missing cache → {}", async () => {
    assert.deepEqual(await loadEmbeddingCache("never-saved-embedder"), {});
  });
});
