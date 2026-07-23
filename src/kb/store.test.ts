import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Point lisaHome() at a temp dir and disable git BEFORE importing the modules
// under test, so paths.ts (evaluated at import) resolves kbDir() there. node's
// test runner isolates each file in its own process, so this can't leak.
const TMP = mkdtempSync(path.join(os.tmpdir(), "lisa-kb-test-"));
process.env.LISA_HOME = TMP;
process.env.LISA_KB_NO_GIT = "1";

const store = await import("./store.js");
const { kbDir, kbSchemaFile, kbIndexFile, entryFile } = await import("./paths.js");

after(() => rmSync(TMP, { recursive: true, force: true }));

describe("kb store", () => {
  test("addSource writes an immutable Layer-1 capture with frontmatter", async () => {
    const e = await store.addSource({
      title: "OAuth PKCE notes",
      body: "PKCE adds a code_verifier / code_challenge to the auth-code flow.",
      tags: ["oauth", "security"],
      origin: "chat:sess-1",
    });
    assert.equal(e.layer, "sources");
    assert.equal(e.slug, "oauth-pkce-notes");
    assert.ok(e.created, "has a created timestamp");

    const back = await store.readEntry("sources", "oauth-pkce-notes");
    assert.ok(back);
    assert.equal(back.title, "OAuth PKCE notes");
    assert.deepEqual(back.tags, ["oauth", "security"]);
    assert.equal(back.origin, "chat:sess-1");
    assert.match(back.body, /code_verifier/);

    // Raw file has a frontmatter block.
    const raw = readFileSync(entryFile("sources", "oauth-pkce-notes"), "utf8");
    assert.match(raw, /^---\ntitle: OAuth PKCE notes\n/);
    assert.match(raw, /tags: \[oauth, security\]/);
  });

  test("addSource never overwrites — a colliding title gets a unique slug", async () => {
    const a = await store.addSource({ title: "Dup", body: "first" });
    const b = await store.addSource({ title: "Dup", body: "second" });
    assert.equal(a.slug, "dup");
    assert.equal(b.slug, "dup-2");
    assert.equal((await store.readEntry("sources", "dup"))!.body, "first");
    assert.equal((await store.readEntry("sources", "dup-2"))!.body, "second");
  });

  test("writeWiki upserts a Layer-2 page by slug", async () => {
    const first = await store.writeWiki({
      title: "OAuth",
      body: "OAuth 2.0 is an authorization framework.",
      tags: ["oauth"],
      sources: ["oauth-pkce-notes"],
    });
    assert.equal(first.slug, "oauth");
    assert.ok(first.updated);

    // Same slug → update, not duplicate.
    const updated = await store.writeWiki({
      slug: "oauth",
      title: "OAuth 2.0",
      body: "OAuth 2.0 is an authorization framework. PKCE hardens the code flow.",
    });
    assert.equal(updated.slug, "oauth");
    const wiki = await store.listEntries("wiki");
    assert.equal(wiki.filter((w) => w.slug === "oauth").length, 1, "no duplicate");
    assert.equal((await store.readEntry("wiki", "oauth"))!.title, "OAuth 2.0");
    assert.match((await store.readEntry("wiki", "oauth"))!.body, /PKCE hardens/);
  });

  test("listEntries filters by layer and sorts newest-first", async () => {
    const wiki = await store.listEntries("wiki");
    assert.ok(wiki.every((e) => e.layer === "wiki"));
    const sources = await store.listEntries("sources");
    assert.ok(sources.every((e) => e.layer === "sources"));
    assert.ok(sources.length >= 3);
    // excerpt is present and bounded
    assert.ok(sources[0]!.excerpt.length <= 160);
  });

  test("ensureScaffold seeds the schema and dirs", async () => {
    await store.ensureKbScaffold();
    assert.ok(existsSync(kbSchemaFile()), "SCHEMA.md seeded");
    assert.ok(existsSync(path.join(kbDir(), "sources")));
    assert.ok(existsSync(path.join(kbDir(), "wiki")));
  });

  test("index.md is regenerated with wiki titles + counts", async () => {
    assert.ok(existsSync(kbIndexFile()), "index.md exists after a write");
    const idx = readFileSync(kbIndexFile(), "utf8");
    assert.match(idx, /# Knowledge base index/);
    assert.match(idx, /wiki page\(s\)/);
    assert.match(idx, /OAuth 2\.0/, "wiki title appears in the index");
  });

  test("index.json is written alongside index.md, with real edges", async () => {
    await store.writeWiki({
      slug: "pkce",
      title: "PKCE",
      body: "Hardens [[oauth]]'s code flow.",
      sources: ["oauth-pkce-notes"],
    });
    const { kbGraphFile } = await import("./paths.js");
    const graph = JSON.parse(readFileSync(kbGraphFile(), "utf8"));
    assert.ok(Array.isArray(graph.nodes) && graph.nodes.length > 0);
    assert.ok(graph.generatedAt);
    const has = (from: string, to: string): boolean =>
      graph.edges.some((e: [string, string]) => e[0] === from && e[1] === to);
    assert.ok(has("wiki/pkce", "sources/oauth-pkce-notes"), "sources: frontmatter is an edge");
    assert.ok(has("wiki/pkce", "wiki/oauth"), "[[wikilink]] in the body is an edge");
  });

  test("removeEntry deletes and reports existence", async () => {
    assert.equal(await store.removeEntry("sources", "dup-2"), true);
    assert.equal(await store.readEntry("sources", "dup-2"), null);
    assert.equal(await store.removeEntry("sources", "dup-2"), false, "already gone");
  });

  test("a Chinese title gets a readable date+hash slug, not entry-<timestamp>", async () => {
    const e = await store.addSource({
      title: "知识库的设计笔记",
      body: "三层结构：来源、维基、schema。",
      tags: ["知识库"],
    });
    assert.match(e.slug, /^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);
    assert.doesNotMatch(e.slug, /^entry-/);
    const back = await store.readEntry("sources", e.slug);
    assert.equal(back!.title, "知识库的设计笔记", "the real title lives in frontmatter");
  });

  test("provenance frontmatter round-trips through `extra`", async () => {
    const e = await store.addSource({
      title: "Ingested article",
      body: "body text",
      origin: "web",
      extra: {
        url: "https://example.com/a?b=1",
        site: "example.com",
        author: "Someone",
        published: "2026-07-20",
        hash: "deadbeef",
      },
    });
    const back = await store.readEntry("sources", e.slug);
    assert.equal(back!.extra?.url, "https://example.com/a?b=1");
    assert.equal(back!.extra?.site, "example.com");
    assert.equal(back!.extra?.hash, "deadbeef");
    assert.equal(back!.origin, "web");
    // Known keys must not leak into extra (they'd be written twice).
    assert.equal(back!.extra?.title, undefined);
    assert.equal(back!.extra?.tags, undefined);
    const raw = readFileSync(entryFile("sources", e.slug), "utf8");
    assert.equal(raw.match(/^title:/gm)?.length, 1, "title written exactly once");
  });

  test("a newline in an extra value cannot forge extra frontmatter lines", async () => {
    const e = await store.addSource({
      title: "Injection attempt",
      body: "b",
      extra: { author: "x\norigin: spoofed\ntitle: spoofed" },
    });
    const back = await store.readEntry("sources", e.slug);
    assert.equal(back!.title, "Injection attempt");
    assert.notEqual(back!.origin, "spoofed");
    assert.match(back!.extra!.author!, /^x origin: spoofed title: spoofed$/);
  });

  test("listEntries surfaces extra so the index/UI can show provenance", async () => {
    const sources = await store.listEntries("sources");
    assert.ok(sources.some((s) => s.extra?.site === "example.com"));
  });

  test("slug jail: a traversal slug throws rather than escaping the KB", async () => {
    await assert.rejects(() => store.readEntry("wiki", "../../etc/passwd"));
    await assert.rejects(() =>
      store.writeWiki({ slug: "../escape", title: "x", body: "y" }),
    );
  });
});
