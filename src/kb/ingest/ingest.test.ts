import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(os.tmpdir(), "lisa-kb-ingest-"));
process.env.LISA_HOME = TMP;
process.env.LISA_KB_NO_GIT = "1";

const { ingestUrl } = await import("./index.js");
const { extractContent } = await import("./readability.js");
const { elementToMarkdown } = await import("./html-to-md.js");
const { extractProvenance } = await import("./provenance.js");
const { readLedger, ingestLedgerFile } = await import("./dedupe.js");
const store = await import("../store.js");

after(() => rmSync(TMP, { recursive: true, force: true }));

// ── offline fixtures (handoff rule: never hit the network in tests) ───

const ARTICLE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <title>Fallback title</title>
  <meta property="og:title" content="向量检索实践">
  <meta property="og:site_name" content="Example Blog">
  <meta property="article:published_time" content="2026-07-01T08:00:00Z">
  <link rel="canonical" href="https://blog.example.com/vector-search">
  <script type="application/ld+json">{"@type":"BlogPosting","headline":"向量检索实践","author":{"@type":"Person","name":"Ada"}}</script>
</head>
<body>
  <nav class="navbar"><a href="/">Home</a><a href="/about">About</a><a href="/tags">Tags</a></nav>
  <div class="sidebar"><a href="/a">l1</a><a href="/b">l2</a><a href="/c">l3</a><a href="/d">l4</a></div>
  <article class="post-content">
    <h1>向量检索实践</h1>
    <p>${"正文第一段，讲 TF-IDF 与 bigram 的取舍。".repeat(4)}</p>
    <p>${"第二段介绍倒排索引的构建流程与缓存策略。".repeat(4)}</p>
    <pre><code class="language-ts">const idx = build(docs);</code></pre>
  </article>
  <footer class="footer"><p>© 2026 Example · <a href="/rss">RSS</a> · <a href="/privacy">Privacy</a></p></footer>
</body>
</html>`;

const htmlResponse = (body: string, type = "text/html; charset=utf-8"): Response =>
  new Response(body, { status: 200, headers: { "content-type": type } });

function stubFetch(map: Record<string, Response | (() => Response)>) {
  const calls: string[] = [];
  const impl = async (url: string): Promise<Response> => {
    calls.push(url);
    const hit = map[url];
    if (!hit) throw new Error(`unexpected fetch: ${url}`);
    return typeof hit === "function" ? hit() : hit.clone();
  };
  return { impl, calls };
}

describe("readability + provenance (offline fixtures)", () => {
  test("extracts the article subtree, dropping nav/sidebar/footer", () => {
    const { content } = extractContent(ARTICLE_HTML);
    const md = elementToMarkdown(content);
    assert.match(md, /TF-IDF/);
    assert.match(md, /```ts/);
    assert.doesNotMatch(md, /Privacy|About|Home/, "chrome removed");
  });

  test("falls back to body when no candidate scores", () => {
    const { content } = extractContent("<html><body><p>tiny page</p></body></html>");
    assert.equal(elementToMarkdown(content), "tiny page");
  });

  test("provenance: og/JSON-LD/link/lang all land", () => {
    const p = extractProvenance(ARTICLE_HTML);
    assert.equal(p.title, "向量检索实践");
    assert.equal(p.site, "Example Blog");
    assert.equal(p.author, "Ada");
    assert.equal(p.published, "2026-07-01T08:00:00Z");
    assert.equal(p.lang, "zh-CN");
    assert.equal(p.canonical, "https://blog.example.com/vector-search");
  });

  test("provenance falls back to <title> and survives malformed JSON-LD", () => {
    const p = extractProvenance(
      `<html><head><title> Plain &amp; Simple </title><script type="application/ld+json">{"@type":"NewsArticle", broken</script></head></html>`,
    );
    assert.equal(p.title, "Plain & Simple");
  });
});

describe("ingestUrl (stubbed fetch)", () => {
  const URL_A = "https://blog.example.com/vector-search?utm_source=tw";

  test("writes a provenance-stamped Layer-1 source", async () => {
    const { impl } = stubFetch({
      "https://blog.example.com/vector-search?utm_source=tw": htmlResponse(ARTICLE_HTML),
    });
    const res = await ingestUrl(URL_A, { fetchImpl: impl, tags: ["search"] });
    assert.equal(res.deduped, false);
    assert.equal(res.via, "generic");
    assert.equal(res.entry.title, "向量检索实践");
    assert.equal(res.entry.origin, "web");
    // canonicalUrl strips the utm_* param before hashing/storing.
    assert.equal(res.entry.extra?.url, "https://blog.example.com/vector-search");
    assert.match(res.entry.extra?.hash ?? "", /^[0-9a-f]{8}$/);
    assert.equal(res.entry.extra?.site, "Example Blog");
    assert.equal(res.entry.extra?.author, "Ada");
    assert.equal(res.entry.extra?.lang, "zh-CN");
    assert.match(res.entry.body, /TF-IDF/);
  });

  test("same URL (even with different tracking params) dedupes to the existing slug", async () => {
    const { impl, calls } = stubFetch({});
    const res = await ingestUrl("https://blog.example.com/vector-search?utm_medium=x", {
      fetchImpl: impl,
    });
    assert.equal(res.deduped, true);
    assert.equal(res.entry.title, "向量检索实践");
    assert.equal(calls.length, 0, "no network on dedupe hit");
  });

  test("force=true re-ingests and records supersedes", async () => {
    const { impl } = stubFetch({
      "https://blog.example.com/vector-search": htmlResponse(ARTICLE_HTML),
    });
    const first = await ingestUrl(URL_A, { fetchImpl: async () => htmlResponse(ARTICLE_HTML) });
    const res = await ingestUrl("https://blog.example.com/vector-search", {
      fetchImpl: impl,
      force: true,
    });
    assert.equal(res.deduped, false);
    assert.equal(res.entry.extra?.supersedes, first.entry.slug);
    // The ledger now points at the fresh capture.
    const again = await ingestUrl(URL_A, { fetchImpl: impl });
    assert.equal(again.entry.slug, res.entry.slug);
  });

  test("private/loopback URLs are rejected before any fetch", async () => {
    const { impl, calls } = stubFetch({});
    for (const bad of ["http://127.0.0.1/x", "http://192.168.1.4/x", "http://localhost:8000/"]) {
      await assert.rejects(() => ingestUrl(bad, { fetchImpl: impl }), /private|loopback/i);
    }
    assert.equal(calls.length, 0);
  });

  test("non-HTML content types are refused; text/plain is captured as-is", async () => {
    await assert.rejects(
      () =>
        ingestUrl("https://cdn.example.com/app.bin", {
          fetchImpl: async () => htmlResponse("binary", "application/octet-stream"),
        }),
      /unsupported content-type/,
    );
    const txt = await ingestUrl("https://cdn.example.com/notes.txt", {
      fetchImpl: async () =>
        htmlResponse("plain text notes, comfortably long enough to pass the minimum body length gate for a capture.", "text/plain"),
      title: "Notes",
    });
    assert.match(txt.entry.body, /plain text notes/);
  });

  test("pages with no extractable content raise a helpful error", async () => {
    await assert.rejects(
      () =>
        ingestUrl("https://spa.example.com/app", {
          fetchImpl: async () => htmlResponse("<html><body><div id=root></div></body></html>"),
        }),
      /could not extract readable content/,
    );
  });

  test("a corrupt ledger is rebuilt from the sources' hash frontmatter", async () => {
    writeFileSync(ingestLedgerFile(), "{not json");
    const ledger = await readLedger();
    const entries = await store.listFullEntries("sources");
    const hashes = new Set(entries.map((e) => e.extra?.hash).filter(Boolean));
    for (const h of hashes) {
      assert.ok(ledger[h as string], `hash ${h} recovered`);
    }
    // And dedupe works again without a fetch.
    const { impl, calls } = stubFetch({});
    const res = await ingestUrl(URL_A, { fetchImpl: impl });
    assert.equal(res.deduped, true);
    assert.equal(calls.length, 0);
  });
});
