import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, parseWikilinks, resolveRef, sortedTags, graphToJson } from "./links.js";
import type { KbEntry } from "./store.js";

function wiki(slug: string, body: string, extra: Partial<KbEntry> = {}): KbEntry {
  return {
    layer: "wiki",
    slug,
    title: slug.toUpperCase(),
    tags: [],
    updated: "2026-07-20T00:00:00.000Z",
    body,
    ...extra,
  };
}
function source(slug: string, body = "raw", extra: Partial<KbEntry> = {}): KbEntry {
  return {
    layer: "sources",
    slug,
    title: slug,
    tags: [],
    created: "2026-07-20T00:00:00.000Z",
    body,
    ...extra,
  };
}

const NOW = Date.parse("2026-07-23T00:00:00.000Z");

describe("parseWikilinks", () => {
  test("plain, aliased and kb-prefixed forms", () => {
    assert.deepEqual(
      parseWikilinks("see [[oauth]], [[pkce|the PKCE page]] and [[kb:jwt]]"),
      ["oauth", "pkce", "jwt"],
    );
  });

  test("deduplicates and ignores non-links", () => {
    assert.deepEqual(parseWikilinks("[[a]] [[a]] [not-a-link] [[]]"), ["a"]);
  });

  test("does not span lines or swallow markdown links", () => {
    assert.deepEqual(parseWikilinks("[text](https://x/[[y]])\n[[real]]"), ["y", "real"]);
  });
});

describe("buildGraph", () => {
  test("wikilinks become forward and backward edges", () => {
    const g = buildGraph([wiki("oauth", "uses [[pkce]]"), wiki("pkce", "part of oauth")], { now: NOW });
    assert.deepEqual(g.forward.get("wiki/oauth"), ["wiki/pkce"]);
    assert.deepEqual(g.back.get("wiki/pkce"), ["wiki/oauth"]);
    // v1.0 had no backlink view at all — this is the new capability.
    assert.equal(g.back.get("wiki/oauth"), undefined);
  });

  test("a wiki page's sources: frontmatter is an edge too", () => {
    const g = buildGraph(
      [wiki("oauth", "distilled", { sources: ["notes-1"] }), source("notes-1")],
      { now: NOW },
    );
    assert.deepEqual(g.forward.get("wiki/oauth"), ["sources/notes-1"]);
    assert.deepEqual(g.back.get("sources/notes-1"), ["wiki/oauth"]);
  });

  test("a bare [[slug]] resolves wiki-first when both layers share it", () => {
    const g = buildGraph(
      [wiki("dup", "x"), source("dup"), wiki("ref", "see [[dup]]")],
      { now: NOW },
    );
    assert.deepEqual(g.forward.get("wiki/ref"), ["wiki/dup"]);
  });

  test("a link to a page that doesn't exist is reported, not silently dropped", () => {
    const g = buildGraph([wiki("a", "see [[ghost]]")], { now: NOW });
    assert.deepEqual(g.broken, [{ from: "wiki/a", target: "ghost" }]);
    assert.equal(g.forward.get("wiki/a"), undefined);
  });

  test("self-links are ignored and never counted as broken", () => {
    const g = buildGraph([wiki("a", "see [[a]]")], { now: NOW });
    assert.equal(g.forward.get("wiki/a"), undefined);
    assert.deepEqual(g.broken, []);
  });

  test("duplicate links collapse to one edge", () => {
    const g = buildGraph([wiki("a", "[[b]] and again [[b]]"), wiki("b", "")], { now: NOW });
    assert.deepEqual(g.forward.get("wiki/a"), ["wiki/b"]);
    assert.equal(g.back.get("wiki/b")!.length, 1);
  });

  test("hubs rank by backlinks, and recency breaks ties", () => {
    const g = buildGraph(
      [
        wiki("hub", "the concept"),
        wiki("a", "see [[hub]]"),
        wiki("b", "see [[hub]]"),
        wiki("cold", "nothing", { updated: "2024-01-01T00:00:00.000Z" }),
      ],
      { now: NOW },
    );
    assert.equal(g.hubs[0]!.key, "wiki/hub");
    assert.equal(g.hubs[0]!.backlinks, 2);
    // A stale, unlinked page sorts last — that's the tail truncation should eat.
    assert.equal(g.hubs.at(-1)!.key, "wiki/cold");
  });

  test("hubs only contain wiki pages — sources are raw captures, not concepts", () => {
    const g = buildGraph([wiki("a", ""), source("s1")], { now: NOW });
    assert.deepEqual(g.hubs.map((h) => h.key), ["wiki/a"]);
  });

  test("orphans are wiki pages with no edges either way", () => {
    const g = buildGraph(
      [wiki("linked", "see [[other]]"), wiki("other", ""), wiki("alone", "")],
      { now: NOW },
    );
    assert.deepEqual(g.orphans, ["wiki/alone"]);
  });

  test("tags are collected and ranked by usage", () => {
    const g = buildGraph(
      [wiki("a", "", { tags: ["ai", "kb"] }), wiki("b", "", { tags: ["ai"] })],
      { now: NOW },
    );
    assert.deepEqual(sortedTags(g), [
      { tag: "ai", count: 2 },
      { tag: "kb", count: 1 },
    ]);
  });
});

describe("resolveRef", () => {
  const g = buildGraph([wiki("oauth", "x"), source("notes-1")], { now: NOW });

  test("accepts bare slugs, wikilinks, kb: prefixes and full keys", () => {
    for (const ref of ["oauth", "[[oauth]]", "kb:oauth", "wiki/oauth", "  [[kb:oauth]] "]) {
      assert.equal(resolveRef(g, ref)?.key, "wiki/oauth", ref);
    }
  });

  test("falls back to the sources layer", () => {
    assert.equal(resolveRef(g, "notes-1")?.key, "sources/notes-1");
  });

  test("unknown and empty refs resolve to null", () => {
    assert.equal(resolveRef(g, "nope"), null);
    assert.equal(resolveRef(g, "  "), null);
  });
});

describe("graphToJson", () => {
  test("flattens to nodes + edge pairs for the UI", () => {
    const g = buildGraph([wiki("a", "[[b]]"), wiki("b", "")], { now: NOW });
    const json = graphToJson(g, "2026-07-23T00:00:00.000Z");
    assert.equal(json.nodes.length, 2);
    assert.deepEqual(json.edges, [["wiki/a", "wiki/b"]]);
    assert.equal(json.generatedAt, "2026-07-23T00:00:00.000Z");
  });
});
