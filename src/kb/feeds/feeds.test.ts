import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(os.tmpdir(), "lisa-kb-feeds-"));
process.env.LISA_HOME = TMP;
process.env.LISA_KB_NO_GIT = "1";

const store = await import("./store.js");
const { parseFeed } = await import("./rss.js");
const brief = await import("./brief.js");
const { parseFeedClassification, classifyFeedItems } = await import("./classify.js");
const { runDailyBrief, pickNewItems, latestBriefJson } = await import("./service.js");
const kbStore = await import("../store.js");
const { kbDir } = await import("../paths.js");

after(() => rmSync(TMP, { recursive: true, force: true }));

// ── fixtures ──────────────────────────────────────────────────────────

const RSS_XML = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><title>Example Feed</title>
<item>
  <title><![CDATA[Transformer 推理优化实践]]></title>
  <link>https://blog.example.com/infer</link>
  <guid>ex-1</guid>
  <pubDate>Wed, 22 Jul 2026 08:00:00 GMT</pubDate>
  <content:encoded><![CDATA[<p>KV cache 与 <b>speculative decoding</b> 的组合。</p>]]></content:encoded>
</item>
<item>
  <title>Weekly links &amp; notes</title>
  <link>https://blog.example.com/links</link>
  <description>assorted reading</description>
</item>
</channel></rss>`;

const ATOM_XML = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Atom Site</title>
<entry>
  <title>Release v2.0</title>
  <id>tag:site,2026:release-2</id>
  <updated>2026-07-22T09:30:00Z</updated>
  <link rel="alternate" href="https://site.dev/release-2"/>
  <summary>Big release with breaking changes.</summary>
</entry>
</feed>`;

const xmlResponse = (body: string): Response =>
  new Response(body, { status: 200, headers: { "content-type": "application/xml" } });

describe("rss parsing", () => {
  test("RSS 2.0: CDATA titles, guid, content:encoded stripped to text", () => {
    const feed = parseFeed(RSS_XML);
    assert.equal(feed.title, "Example Feed");
    assert.equal(feed.items.length, 2);
    const [a, b] = feed.items;
    assert.equal(a!.id, "ex-1");
    assert.equal(a!.title, "Transformer 推理优化实践");
    assert.equal(a!.link, "https://blog.example.com/infer");
    assert.match(a!.summary ?? "", /KV cache 与 speculative decoding/);
    assert.equal(b!.title, "Weekly links & notes");
    assert.equal(b!.id, "https://blog.example.com/links", "no guid → link as id");
  });

  test("Atom: entry/id/updated/link@href/summary", () => {
    const feed = parseFeed(ATOM_XML);
    assert.equal(feed.title, "Atom Site");
    const e = feed.items[0]!;
    assert.equal(e.id, "tag:site,2026:release-2");
    assert.equal(e.link, "https://site.dev/release-2");
    assert.equal(e.published, "2026-07-22T09:30:00Z");
  });
});

describe("brief scheduling + ranking (pure)", () => {
  test("isBriefDue mirrors mail's isDigestDue semantics", () => {
    const at = (h: number): Date => new Date(2026, 6, 23, h, 0, 0);
    assert.equal(brief.isBriefDue(null, at(9), 8), true);
    assert.equal(brief.isBriefDue(null, at(7), 8), false);
    assert.equal(brief.isBriefDue(brief.localDate(at(9).getTime()), at(9), 8), false, "already ran today");
    assert.equal(brief.isBriefDue("2026-07-22", at(9), 8), true, "yesterday's run doesn't count");
  });

  test("scoreItem: importance, watchlist weight, and interest overlap all lift the score", () => {
    const signals = brief.buildSignals({
      memoryText: "研究方向：LLM 推理优化、KV cache",
      wikiTitles: ["Speculative decoding"],
      feedWeight: { hot: 2, cold: 1 },
    });
    const base = brief.scoreItem({ feedId: "cold", title: "gardening tips", importance: 1 }, signals);
    const relevant = brief.scoreItem(
      { feedId: "cold", title: "KV cache 推理优化", summary: "speculative decoding", importance: 1 },
      signals,
    );
    const weighted = brief.scoreItem({ feedId: "hot", title: "gardening tips", importance: 1 }, signals);
    const important = brief.scoreItem({ feedId: "cold", title: "gardening tips", importance: 3 }, signals);
    assert.ok(relevant > base, "interest/wiki overlap outranks unrelated");
    assert.ok(weighted > base, "watchlist weight lifts");
    assert.ok(important > base, "importance lifts");
  });

  test("buildBrief sorts by score and formatBriefText renders links + ingested wikilinks", () => {
    const items = [
      { feedId: "a", id: "1", title: "minor", category: "other", importance: 1, oneLine: "meh", score: 1 },
      { feedId: "a", id: "2", title: "major", link: "https://x.dev/2", category: "release", importance: 3, oneLine: "重大更新", score: 9 },
    ] as const;
    const b = brief.buildBrief([...items] as never, { date: "2026-07-23", feedCount: 1, ingested: ["x-slug"], now: () => 0 });
    assert.equal(b.items[0]!.title, "major");
    const text = brief.formatBriefText(b);
    assert.match(text, /‼ \*\*major\*\* — https:\/\/x\.dev\/2/);
    assert.match(text, /重大更新/);
    assert.match(text, /\[\[x-slug\]\]/);
  });
});

describe("classification (validated against the closed taxonomy)", () => {
  const items = [
    { id: "i1", title: "GPT-6 released" },
    { id: "i2", title: "misc post" },
  ];

  test("valid reply is parsed; junk fields are clamped/defaulted", () => {
    const reply = JSON.stringify([
      { id: "i1", category: "release", importance: 3, oneLine: "major model release" },
      { id: "i2", category: "hacked-category", importance: 99, oneLine: "" },
    ]);
    const out = parseFeedClassification(reply, items);
    assert.deepEqual(out[0], { id: "i1", category: "release", importance: 3, oneLine: "major model release" });
    assert.equal(out[1]!.category, "other", "unknown category rejected");
    assert.equal(out[1]!.importance, 3, "clamped to max 3");
    assert.equal(out[1]!.oneLine, "misc post", "empty oneLine falls back to title");
  });

  test("model failure → neutral defaults, never dropped", async () => {
    const res = await classifyFeedItems(items, {
      runModel: async () => {
        throw new Error("no provider");
      },
    });
    assert.equal(res.items.length, 2);
    assert.equal(res.items[0]!.importance, 1);
  });

  test("budget gate: batches stop at the ceiling and remaining items get defaults", async () => {
    let calls = 0;
    const many = Array.from({ length: 4 }, (_, i) => ({ id: `m${i}`, title: `t${i}` }));
    const res = await classifyFeedItems(many, {
      batchSize: 1,
      budgetTokens: 1000,
      runModel: async () => {
        calls++;
        return { text: "[]", tokens: 600 };
      },
    });
    assert.equal(calls, 2, "third batch would exceed 1000 — stopped after spend >= budget");
    assert.equal(res.budgetHit, true);
    assert.equal(res.items.length, 4, "all items still graded (defaults)");
  });
});

describe("runDailyBrief (offline, injected seams)", () => {
  test("no feeds.json → fully inert (no fetch, returns null)", async () => {
    let fetched = 0;
    const res = await runDailyBrief({
      force: true,
      fetchImpl: async () => {
        fetched++;
        return xmlResponse(RSS_XML);
      },
    });
    assert.equal(res, null);
    assert.equal(fetched, 0);
  });

  test("end-to-end: sweep → classify → rank → topN ingest → two outputs written", async () => {
    mkdirSync(kbDir(), { recursive: true });
    writeFileSync(
      path.join(kbDir(), "feeds.json"),
      JSON.stringify({ feeds: [{ id: "blog", url: "https://blog.example.com/rss" }], briefHour: 8 }),
    );
    const ingestedUrls: string[] = [];
    const res = await runDailyBrief({
      force: true,
      fetchImpl: async (url) => {
        assert.equal(url, "https://blog.example.com/rss");
        return xmlResponse(RSS_XML);
      },
      runModel: async () => ({
        text: JSON.stringify([
          { id: "ex-1", category: "engineering", importance: 3, oneLine: "推理优化干货" },
          { id: "https://blog.example.com/links", category: "other", importance: 0, oneLine: "links" },
        ]),
        tokens: 500,
      }),
      ingest: async (url) => {
        ingestedUrls.push(url);
        return `slug-${ingestedUrls.length}`;
      },
    });
    assert.ok(res, "brief produced");
    assert.equal(res!.brief.total, 2);
    assert.equal(res!.brief.items[0]!.title, "Transformer 推理优化实践", "importance-3 item ranks first");
    assert.equal(ingestedUrls[0], "https://blog.example.com/infer", "top item full-text ingested first");
    assert.match(res!.text, /推理优化干货/);

    // D7: written twice.
    const json = await latestBriefJson();
    assert.equal(json?.date, res!.brief.date);
    const sources = await kbStore.listEntries("sources");
    const briefEntry = sources.find((e) => e.origin === "brief");
    assert.ok(briefEntry, "sources/brief-<date>.md exists");
    assert.match(briefEntry!.slug, /^brief-\d{4}-\d{2}-\d{2}/);

    // feeds.json got 0600 + kb/.gitignore covers it.
    const gitignore = readFileSync(path.join(kbDir(), ".gitignore"), "utf8");
    assert.match(gitignore, /feeds\.json/);
    assert.match(gitignore, /feeds\//);
  });

  test("incremental: second run same day is not due; forced re-run sees no new items", async () => {
    const res = await runDailyBrief({
      fetchImpl: async () => xmlResponse(RSS_XML),
    });
    assert.equal(res, null, "already ran today (lastBriefDate gate)");

    const forced = await runDailyBrief({
      force: true,
      fetchImpl: async () => xmlResponse(RSS_XML),
      runModel: async () => ({ text: "[]", tokens: 0 }),
      ingest: async () => null,
    });
    assert.equal(forced, null, "all items already seen — nothing fresh");
  });

  test("pickNewItems dedupes by id and honors the per-feed cap", () => {
    const items = [
      { id: "a", title: "a" },
      { id: "b", title: "b" },
      { id: "c", title: "c" },
    ];
    assert.deepEqual(pickNewItems(items, ["a"], 1).map((i) => i.id), ["b"]);
  });

  test("all feeds failing does NOT burn the day (retries next tick)", async () => {
    rmSync(path.join(kbDir(), "feeds", ".state.json"), { force: true });
    const res = await runDailyBrief({
      force: true,
      fetchImpl: async () => new Response("nope", { status: 500 }),
    });
    assert.equal(res, null);
    const state = await store.loadFeedsState();
    assert.equal(state.lastBriefDate, null, "day not marked — will retry");
  });
});
