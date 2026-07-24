import { test, describe, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Point lisaHome() at a temp dir before importing (see store.test.ts).
const TMP = mkdtempSync(path.join(os.tmpdir(), "lisa-kb-search-"));
process.env.LISA_HOME = TMP;
process.env.LISA_KB_NO_GIT = "1";

const store = await import("./store.js");
const { searchKb, clearKbIndexCache } = await import("./search.js");

after(() => rmSync(TMP, { recursive: true, force: true }));

before(async () => {
  await store.addSource({
    title: "知识库的设计",
    body: "这篇公众号文章讲的是知识库的设计，重点在检索和索引。",
    tags: ["知识库"],
  });
  await store.addSource({
    title: "OAuth PKCE",
    body: "PKCE adds a code_verifier to the authorization code flow.",
    tags: ["oauth"],
  });
  await store.addSource({
    title: "苹果手机评测",
    body: "关于苹果手机的一些使用感受。",
  });
  clearKbIndexCache();
});

describe("kb search — CJK", () => {
  test("a Chinese substring query finds the Chinese entry", async () => {
    // Regression: with whitespace-only tokenization a Chinese clause became one
    // token, so this query returned nothing at all.
    const hits = await searchKb("知识库", 5);
    assert.ok(hits.length > 0, "expected at least one hit for 知识库");
    assert.equal(hits[0]!.title, "知识库的设计");
  });

  test("a mid-clause phrase that is not a title still matches", async () => {
    const hits = await searchKb("检索", 5);
    assert.ok(hits.some((h) => h.title === "知识库的设计"));
  });

  test("an unrelated Chinese query does not pull the wrong entry first", async () => {
    const hits = await searchKb("苹果手机", 5);
    assert.equal(hits[0]!.title, "苹果手机评测");
  });

  test("mixed latin/CJK queries work from either side", async () => {
    assert.ok((await searchKb("pkce", 5)).some((h) => h.title === "OAuth PKCE"));
    assert.ok((await searchKb("公众号", 5)).some((h) => h.title === "知识库的设计"));
  });

  test("english search is unchanged", async () => {
    const hits = await searchKb("code_verifier authorization", 5);
    assert.equal(hits[0]!.title, "OAuth PKCE");
  });

  test("a query with no overlap returns nothing", async () => {
    assert.equal((await searchKb("quantum chromodynamics", 5)).length, 0);
  });
});
