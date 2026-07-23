import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolContext, ToolDefinition } from "../types.js";

const TMP = mkdtempSync(path.join(os.tmpdir(), "lisa-kb-tool-"));
process.env.LISA_HOME = TMP;
process.env.LISA_KB_NO_GIT = "1";

const store = await import("./store.js");
const search = await import("./search.js");
const { kbTools } = await import("./tool.js");
const registry = await import("../tools/registry.js");

after(() => rmSync(TMP, { recursive: true, force: true }));

const CTX: ToolContext = {
  cwd: process.cwd(),
  signal: new AbortController().signal,
  log: () => {},
};
const tool = (name: string): ToolDefinition =>
  kbTools.find((t) => t.name === name)!;
const run = (name: string, input: unknown): Promise<unknown> =>
  tool(name).execute(input, CTX);

describe("kb search + tools", () => {
  test("TF-IDF search ranks the relevant entry above an unrelated one", async () => {
    search.clearKbIndexCache();
    await store.addSource({
      title: "OAuth PKCE",
      body: "PKCE uses a code_verifier and code_challenge in the auth code flow.",
      tags: ["oauth"],
    });
    await store.addSource({
      title: "Sourdough",
      body: "Feed the starter with flour and water each day.",
      tags: ["baking"],
    });
    await store.writeWiki({
      title: "OAuth",
      body: "OAuth 2.0 authorization framework; PKCE hardens the code flow.",
      tags: ["oauth"],
    });
    search.clearKbIndexCache();
    const hits = await search.searchKb("pkce code verifier", 5);
    assert.ok(hits.length >= 1, "found something");
    assert.match(hits[0]!.title, /OAuth/i, "OAuth entry ranks first");
    assert.ok(
      !hits.some((h) => /sourdough/i.test(h.title)),
      "unrelated entry not returned",
    );
  });

  test("kb_add captures a source", async () => {
    const out = (await run("kb_add", {
      title: "Meeting notes",
      content: "Decided to ship v2 next week.",
      tags: ["work"],
    })) as string;
    assert.match(out, /Saved source/);
    const e = await store.readEntry("sources", "meeting-notes");
    assert.ok(e);
    assert.match(e.body, /ship v2/);
  });

  test("kb_write upserts a wiki page", async () => {
    const out = (await run("kb_write", {
      slug: "projects",
      title: "Projects",
      content: "Current: v2 launch.",
      tags: ["work"],
    })) as string;
    assert.match(out, /Wrote wiki page/);
    const e = await store.readEntry("wiki", "projects");
    assert.match(e!.body, /v2 launch/);
  });

  test("kb_write auto-links mentions of existing wiki pages (own page excluded)", async () => {
    await run("kb_write", {
      slug: "auth-notes",
      title: "Auth notes",
      content: "We standardized on OAuth for third-party APIs.",
    });
    const e = await store.readEntry("wiki", "auth-notes");
    assert.match(e!.body, /\[\[oauth\|OAuth\]\]/, "prose mention became a link");

    // Re-writing the OAuth page itself must not self-link.
    await run("kb_write", {
      slug: "oauth",
      title: "OAuth",
      content: "OAuth 2.0 authorization framework; PKCE hardens the code flow.",
    });
    const self = await store.readEntry("wiki", "oauth");
    assert.doesNotMatch(self!.body, /\[\[oauth/, "no self-link on upsert");
  });

  test("kb_read + kb_list format entries", async () => {
    const read = (await run("kb_read", { layer: "wiki", slug: "projects" })) as string;
    assert.match(read, /# Projects/);
    assert.match(read, /v2 launch/);
    const list = (await run("kb_list", {})) as string;
    assert.match(list, /projects/);
    assert.match(list, /meeting-notes/);
  });

  test("kb_search returns matches, and a clear miss message", async () => {
    const out = (await run("kb_search", { query: "pkce" })) as string;
    assert.match(out, /oauth/i);
    const none = (await run("kb_search", { query: "zzzznotarealtoken" })) as string;
    assert.match(none, /no matches/);
  });

  test("registry: kb tools registered with correct subset membership", async () => {
    const all = registry.buildToolRegistry();
    const names = new Set(all.map((t) => t.name));
    for (const n of ["kb_search", "kb_read", "kb_list", "kb_add", "kb_write"]) {
      assert.ok(names.has(n), `${n} is registered`);
    }
    const ro = new Set(registry.readOnlySubset(all).map((t) => t.name));
    assert.ok(ro.has("kb_search") && ro.has("kb_read") && ro.has("kb_list"), "reads are read-only");
    assert.ok(!ro.has("kb_add") && !ro.has("kb_write"), "writes are not read-only");

    const auto = new Set(registry.autonomousSubset(all).map((t) => t.name));
    assert.ok(auto.has("kb_add") && auto.has("kb_write"), "writes ALLOWED for autonomous (tend the wiki)");

    const remote = new Set(registry.remoteSafeSubset(all).map((t) => t.name));
    assert.ok(remote.has("kb_search"), "read tools are remote-safe");
    assert.ok(!remote.has("kb_add") && !remote.has("kb_write"), "writes are remote-blocked");
  });
});
