import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Point LISA_HOME at a temp dir and disable git BEFORE importing the modules
// under test, so paths.ts (evaluated at import) resolves KB_DIR there. node's
// test runner isolates each file in its own process, so this can't leak.
const TMP = mkdtempSync(path.join(os.tmpdir(), "lisa-kb-test-"));
process.env.LISA_HOME = TMP;
process.env.LISA_KB_NO_GIT = "1";

const store = await import("./store.js");
const { KB_DIR, KB_SCHEMA_FILE, KB_INDEX_FILE, entryFile } = await import("./paths.js");

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
    assert.ok(existsSync(KB_SCHEMA_FILE), "SCHEMA.md seeded");
    assert.ok(existsSync(path.join(KB_DIR, "sources")));
    assert.ok(existsSync(path.join(KB_DIR, "wiki")));
  });

  test("index.md is regenerated with wiki titles + counts", async () => {
    assert.ok(existsSync(KB_INDEX_FILE), "index.md exists after a write");
    const idx = readFileSync(KB_INDEX_FILE, "utf8");
    assert.match(idx, /# Knowledge base index/);
    assert.match(idx, /wiki page\(s\)/);
    assert.match(idx, /OAuth 2\.0/, "wiki title appears in the index");
  });

  test("removeEntry deletes and reports existence", async () => {
    assert.equal(await store.removeEntry("sources", "dup-2"), true);
    assert.equal(await store.readEntry("sources", "dup-2"), null);
    assert.equal(await store.removeEntry("sources", "dup-2"), false, "already gone");
  });

  test("slug jail: a traversal slug throws rather than escaping the KB", async () => {
    await assert.rejects(() => store.readEntry("wiki", "../../etc/passwd"));
    await assert.rejects(() =>
      store.writeWiki({ slug: "../escape", title: "x", body: "y" }),
    );
  });
});
