import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(os.tmpdir(), "lisa-kb-memlinks-"));
process.env.LISA_HOME = TMP;
process.env.LISA_KB_NO_GIT = "1";

const { annotateKbLinks, annotateMemoryKbLinks, clearKbTitleCache } = await import(
  "./memory-links.js"
);
const kb = await import("./store.js");

after(() => rmSync(TMP, { recursive: true, force: true }));

describe("annotateKbLinks (pure)", () => {
  const titles = new Map([
    ["oauth", "OAuth 与 PKCE"],
    ["wiki/oauth", "OAuth 与 PKCE"],
    ["plain", "plain"],
  ]);
  const lookup = (ref: string): string | undefined => titles.get(ref);

  test("appends the title to resolvable [[kb:slug]] links", () => {
    assert.equal(
      annotateKbLinks("详见 [[kb:oauth]]。", lookup),
      "详见 [[kb:oauth]](OAuth 与 PKCE)。",
    );
  });

  test("bare [[slug]] and [[layer/slug]] forms resolve too", () => {
    assert.equal(annotateKbLinks("see [[oauth]]", lookup), "see [[oauth]](OAuth 与 PKCE)");
    assert.equal(
      annotateKbLinks("see [[wiki/oauth]]", lookup),
      "see [[wiki/oauth]](OAuth 与 PKCE)",
    );
  });

  test("unresolvable links are preserved verbatim (they signal a page to write)", () => {
    assert.equal(annotateKbLinks("todo [[kb:not-yet]]", lookup), "todo [[kb:not-yet]]");
  });

  test("links with display text or an existing annotation pass through", () => {
    assert.equal(annotateKbLinks("[[oauth|the page]]", lookup), "[[oauth|the page]]");
    assert.equal(annotateKbLinks("[[oauth]](already)", lookup), "[[oauth]](already)");
  });

  test("title identical to the slug adds nothing", () => {
    assert.equal(annotateKbLinks("[[plain]]", lookup), "[[plain]]");
  });
});

describe("annotateMemoryKbLinks (against kb/index.json)", () => {
  test("resolves against the store's generated index.json", async () => {
    const e = await kb.writeWiki({ title: "OAuth", body: "authorization framework" });
    clearKbTitleCache();
    const out = await annotateMemoryKbLinks(`- auth notes live at [[kb:${e.slug}]]`);
    assert.equal(out, `- auth notes live at [[kb:${e.slug}]](OAuth)`);
  });

  test("picks up KB changes (fingerprint cache invalidates on write)", async () => {
    const e = await kb.writeWiki({ title: "向量检索笔记", body: "bigram + tf-idf" });
    const out = await annotateMemoryKbLinks(`[[kb:${e.slug}]]`);
    assert.equal(out, `[[kb:${e.slug}]](向量检索笔记)`);
  });

  test("text without [[ returns identical (fast path)", async () => {
    assert.equal(await annotateMemoryKbLinks("no links here"), "no links here");
  });
});
