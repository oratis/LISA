import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Embedder, PostJson } from "./embedding.js";
import type { Index, Document } from "./vector.js";

// semanticSearch → ensureEmbeddings now reads/writes the on-disk embedding
// cache; point it at a throwaway lisaHome() so the suite never touches the real
// ~/.lisa. Set before importing the modules (paths.js captures lisaHome() once).
process.env.LISA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-emb-"));

const { cosineSimilarity, parseOllamaEmbedding, OllamaEmbedder } = await import("./embedding.js");
const { semanticSearch } = await import("./vector.js");

describe("cosineSimilarity", () => {
  test("identical → 1", () => assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1));
  test("orthogonal → 0", () => assert.equal(cosineSimilarity([1, 0], [0, 1]), 0));
  test("opposite → -1", () => assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1));
  test("zero vector → 0, not NaN", () => assert.equal(cosineSimilarity([0, 0], [1, 1]), 0));
});

describe("parseOllamaEmbedding", () => {
  test("extracts a numeric embedding array", () => {
    assert.deepEqual(parseOllamaEmbedding(JSON.stringify({ embedding: [0.1, 0.2] })), [0.1, 0.2]);
  });
  test("rejects non-number arrays / missing / malformed", () => {
    assert.equal(parseOllamaEmbedding(JSON.stringify({ embedding: ["a"] })), null);
    assert.equal(parseOllamaEmbedding(JSON.stringify({})), null);
    assert.equal(parseOllamaEmbedding("nope"), null);
  });
});

describe("OllamaEmbedder", () => {
  test("posts to /api/embeddings per text and collects vectors", async () => {
    const urls: string[] = [];
    const post: PostJson = async (url) => {
      urls.push(url);
      return { ok: true, status: 200, body: JSON.stringify({ embedding: [1, 0] }) };
    };
    const e = new OllamaEmbedder("nomic-embed-text", "http://h:1", post);
    const vecs = await e.embed(["a", "b"]);
    assert.equal(vecs.length, 2);
    assert.deepEqual(vecs[0], [1, 0]);
    assert.match(urls[0]!, /\/api\/embeddings$/);
    assert.equal(e.id, "ollama:nomic-embed-text");
  });
  test("throws when the backend is unreachable", async () => {
    const post: PostJson = async () => ({ ok: false, status: 0, body: "" });
    await assert.rejects(new OllamaEmbedder("m", "http://h", post).embed(["x"]), /embedding failed/);
  });
});

function doc(id: string, text: string): Document {
  return { sessionId: id, startedAt: "2026-01-01", text, tokens: [], tokenSet: new Set(), termFreq: new Map() };
}

// "network"/"connection" → [1,0]; else → [0,1]. Lets us prove semantic search
// catches a paraphrase ("connection" vs "network error") with no shared tokens.
const fakeEmbedder: Embedder = {
  id: "fake",
  async embed(texts) {
    return texts.map((t) => (/network|connection/i.test(t) ? [1, 0] : [0, 1]));
  },
};

describe("semanticSearch", () => {
  test("ranks the semantic match first even with zero lexical overlap", async () => {
    const index: Index = {
      docs: [doc("cats", "the cats slept"), doc("net", "a network error occurred"), doc("dogs", "the dogs ran")],
      idf: new Map(),
    };
    const hits = await semanticSearch(index, "connection failed", fakeEmbedder, 2);
    assert.equal(hits[0]!.sessionId, "net");
  });

  test("caches doc vectors on the index (keyed by embedderId)", async () => {
    const index: Index = { docs: [doc("a", "network")], idf: new Map() };
    await semanticSearch(index, "connection", fakeEmbedder, 1);
    assert.equal(index.embedderId, "fake");
    assert.ok(index.embeddings?.has("a"));
  });

  test("empty query / empty index → []", async () => {
    assert.deepEqual(await semanticSearch({ docs: [], idf: new Map() }, "x", fakeEmbedder), []);
    assert.deepEqual(await semanticSearch({ docs: [doc("a", "x")], idf: new Map() }, "  ", fakeEmbedder), []);
  });

  test("falls back to TF-IDF (no throw) when the embedder is down", async () => {
    const boom: Embedder = {
      id: "boom",
      async embed() {
        throw new Error("down");
      },
    };
    const hits = await semanticSearch({ docs: [doc("a", "alpha")], idf: new Map() }, "alpha", boom, 5);
    assert.ok(Array.isArray(hits));
  });
});
