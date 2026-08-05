import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(os.tmpdir(), "lisa-kb-adapters-"));
process.env.LISA_HOME = TMP;
process.env.LISA_KB_NO_GIT = "1";

const { wechatAdapter } = await import("./wechat.js");
const { bilibiliAdapter } = await import("./bilibili.js");
const { youtubeAdapter, videoIdOf } = await import("./youtube.js");
const { parseJson3, parseBilibiliSubtitle, formatVideoBody, formatDuration } = await import(
  "./subtitle.js"
);
const { pickSubtitleUrl } = await import("./ytdlp.js");
const { ingestUrl, ADAPTERS } = await import("../index.js");
const { kbDir } = await import("../../paths.js");
import type { IngestContext } from "../types.js";

after(() => rmSync(TMP, { recursive: true, force: true }));

// ── helpers (offline only — a fetch outside the map is a test failure) ─

const resp = (body: string, opts: { status?: number; type?: string; url?: string } = {}): Response => {
  const r = new Response(body, {
    status: opts.status ?? 200,
    headers: { "content-type": opts.type ?? "text/html" },
  });
  if (opts.url) Object.defineProperty(r, "url", { value: opts.url });
  return r;
};

function ctxOf(
  routes: Record<string, Response | (() => Response)>,
  ytDlp?: Record<string, unknown> | null,
): IngestContext & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetchImpl: async (url: string) => {
      calls.push(url);
      const key = Object.keys(routes).find((k) => url.startsWith(k));
      if (!key) throw new Error(`unexpected fetch in test: ${url}`);
      const hit = routes[key]!;
      return typeof hit === "function" ? hit() : hit.clone();
    },
    ytDlpDumpJson: async () => ytDlp ?? null,
  };
}

// ── wechat ────────────────────────────────────────────────────────────

const WECHAT_HTML = `<html><head>
<meta property="og:title" content="产品思考:一个实验">
<meta property="og:article:author" content="fallback-author">
</head><body>
<div class="rich_media"><a id="js_name"> 好奇心实验室 </a>
<div id="js_content"><p>第一段观点。</p><p><img data-src="https://mmbiz.qpic.cn/x.png" alt=""></p><p>第二段结论。</p></div>
</div>
<script>var ct = "1751500800";</script>
</body></html>`;

describe("wechat adapter", () => {
  test("matches only mp.weixin.qq.com/s*", () => {
    assert.ok(wechatAdapter.match(new URL("https://mp.weixin.qq.com/s/abc123")));
    assert.ok(!wechatAdapter.match(new URL("https://weixin.qq.com/")));
    assert.ok(!wechatAdapter.match(new URL("https://mp.weixin.qq.com/profile")));
  });

  test("extracts js_content, account name, data-src images, epoch publish time", async () => {
    const ctx = ctxOf({ "https://mp.weixin.qq.com/s/ok": resp(WECHAT_HTML) });
    const out = await wechatAdapter.fetch(new URL("https://mp.weixin.qq.com/s/ok"), ctx);
    assert.equal(out.title, "产品思考:一个实验");
    assert.equal(out.extra?.author, "好奇心实验室");
    assert.equal(out.extra?.site, "微信公众号");
    assert.equal(out.extra?.published, new Date(1751500800 * 1000).toISOString());
    assert.match(out.body, /第一段观点。/);
    assert.match(out.body, /!\[\]\(https:\/\/mmbiz\.qpic\.cn\/x\.png\)/, "data-src image kept");
    assert.doesNotMatch(out.body, /var ct/, "scripts dropped");
  });

  test("verification interstitial → loud, actionable error (never a blank entry)", async () => {
    const ctx = ctxOf({
      "https://mp.weixin.qq.com/s/blocked": resp(
        `<html><body><div class="weui-msg"><p>当前环境异常，完成验证后即可继续访问。</p></div></body></html>`,
      ),
    });
    await assert.rejects(
      () => wechatAdapter.fetch(new URL("https://mp.weixin.qq.com/s/blocked"), ctx),
      /验证页.*kb_add/s,
    );
  });
});

// ── bilibili ──────────────────────────────────────────────────────────

const BILI_VIEW = JSON.stringify({
  code: 0,
  data: {
    bvid: "BV1xx411c7mD",
    cid: 12345,
    title: "从零实现倒排索引",
    desc: "一步步实现一个小搜索引擎。",
    tname: "科技",
    duration: 754,
    pubdate: 1751000000,
    owner: { name: "编码小课" },
  },
});

describe("bilibili adapter", () => {
  test("matches video pages and b23.tv, not the rest of bilibili", () => {
    assert.ok(bilibiliAdapter.match(new URL("https://www.bilibili.com/video/BV1xx411c7mD")));
    assert.ok(bilibiliAdapter.match(new URL("https://b23.tv/abc")));
    assert.ok(!bilibiliAdapter.match(new URL("https://www.bilibili.com/read/cv123")));
  });

  test("no SESSDATA → metadata + desc, transcript marked unavailable with the how-to", async () => {
    const ctx = ctxOf({ "https://api.bilibili.com/x/web-interface/view": resp(BILI_VIEW, { type: "application/json" }) });
    const out = await bilibiliAdapter.fetch(new URL("https://www.bilibili.com/video/BV1xx411c7mD"), ctx);
    assert.equal(out.title, "从零实现倒排索引");
    assert.equal(out.extra?.author, "编码小课");
    assert.match(out.extra?.transcript ?? "", /^unavailable \(.*sessdata/i);
    assert.match(out.body, /## 简介/);
    assert.match(out.body, /12:34/, "duration formatted");
    assert.doesNotMatch(out.body, /## 字幕/);
  });

  test("with SESSDATA the built-in subtitle layer runs and lands in the body", async () => {
    mkdirSync(kbDir(), { recursive: true });
    writeFileSync(path.join(kbDir(), "feeds.json"), JSON.stringify({ sessdata: "secret" }));
    const ctx = ctxOf({
      "https://api.bilibili.com/x/web-interface/view": resp(BILI_VIEW, { type: "application/json" }),
      "https://api.bilibili.com/x/player/v2": resp(
        JSON.stringify({
          code: 0,
          data: { subtitle: { subtitles: [{ lan: "zh-CN", subtitle_url: "//aisubtitle.hdslb.com/x.json" }] } },
        }),
        { type: "application/json" },
      ),
      "https://aisubtitle.hdslb.com/x.json": resp(
        JSON.stringify({ body: [{ content: "第一句" }, { content: "第二句" }] }),
        { type: "application/json" },
      ),
    });
    try {
      const out = await bilibiliAdapter.fetch(new URL("https://www.bilibili.com/video/BV1xx411c7mD"), ctx);
      assert.equal(out.extra?.transcript, "builtin");
      assert.match(out.body, /## 字幕\n\n第一句\n第二句/);
    } finally {
      rmSync(path.join(kbDir(), "feeds.json"), { force: true });
    }
  });

  test("b23.tv short links resolve through the guarded fetch", async () => {
    const ctx = ctxOf({
      "https://b23.tv/xyz": () =>
        resp("<html></html>", {
          url: "https://www.bilibili.com/video/BV1xx411c7mD?share_source=copy",
        }),
      "https://api.bilibili.com/x/web-interface/view": resp(BILI_VIEW, { type: "application/json" }),
    });
    const out = await bilibiliAdapter.fetch(new URL("https://b23.tv/xyz"), ctx);
    assert.equal(out.title, "从零实现倒排索引");
  });

  test("view API error → real error (the video itself is unreachable)", async () => {
    const ctx = ctxOf({
      "https://api.bilibili.com/x/web-interface/view": resp(
        JSON.stringify({ code: -404, message: "啥都木有" }),
        { type: "application/json" },
      ),
    });
    await assert.rejects(
      () => bilibiliAdapter.fetch(new URL("https://www.bilibili.com/video/BV1xx411c7mD"), ctx),
      /啥都木有/,
    );
  });
});

// ── youtube ───────────────────────────────────────────────────────────

const OEMBED = JSON.stringify({ title: "Attention Is All You Need — explained", author_name: "ML Channel" });
const PLAYER_WITH_CAPTIONS = JSON.stringify({
  videoDetails: {
    title: "Attention Is All You Need — explained",
    author: "ML Channel",
    shortDescription: "A walkthrough of the transformer paper.",
    lengthSeconds: "1234",
  },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        { baseUrl: "https://www.youtube.com/api/timedtext?v=abc", languageCode: "en", kind: "asr" },
        { baseUrl: "https://www.youtube.com/api/timedtext?v=abc&manual", languageCode: "en" },
      ],
    },
  },
  microformat: { playerMicroformatRenderer: { publishDate: "2026-06-30" } },
});
const JSON3 = JSON.stringify({
  events: [{ segs: [{ utf8: "hello " }, { utf8: "world" }] }, { segs: [{ utf8: "second line" }] }],
});

describe("youtube adapter", () => {
  test("video id extraction across url shapes", () => {
    assert.equal(videoIdOf(new URL("https://www.youtube.com/watch?v=dQw4w9WgXcQ")), "dQw4w9WgXcQ");
    assert.equal(videoIdOf(new URL("https://youtu.be/dQw4w9WgXcQ")), "dQw4w9WgXcQ");
    assert.equal(videoIdOf(new URL("https://www.youtube.com/shorts/abcdEFGH123")), "abcdEFGH123");
    assert.equal(videoIdOf(new URL("https://www.youtube.com/feed/library")), null);
  });

  test("built-in captions: manual track preferred, json3 parsed into the body", async () => {
    const ctx = ctxOf({
      "https://www.youtube.com/oembed": resp(OEMBED, { type: "application/json" }),
      "https://www.youtube.com/youtubei/v1/player": resp(PLAYER_WITH_CAPTIONS, { type: "application/json" }),
      "https://www.youtube.com/api/timedtext?v=abc&manual": resp(JSON3, { type: "application/json" }),
    });
    const out = await youtubeAdapter.fetch(new URL("https://youtu.be/abc12345678"), ctx);
    assert.equal(out.extra?.transcript, "builtin");
    assert.match(out.body, /hello world\nsecond line/);
    assert.match(out.body, /20:34/, "lengthSeconds formatted");
    assert.equal(out.extra?.published, "2026-06-30");
    assert.ok(
      ctx.calls.some((u) => u.includes("&manual&fmt=json3")),
      "manual (non-asr) track chosen",
    );
  });

  test("empty 200 from InnerTube → yt-dlp layer → still degrades gracefully to metadata", async () => {
    const ctx = ctxOf(
      {
        "https://www.youtube.com/oembed": resp(OEMBED, { type: "application/json" }),
        "https://www.youtube.com/youtubei/v1/player": resp("", { type: "application/json" }),
      },
      null, // yt-dlp not installed
    );
    const out = await youtubeAdapter.fetch(new URL("https://www.youtube.com/watch?v=abc12345678"), ctx);
    assert.equal(out.title, "Attention Is All You Need — explained");
    assert.match(out.extra?.transcript ?? "", /^unavailable \(/);
    assert.match(out.body, /- 链接: https:\/\/www\.youtube\.com\/watch\?v=abc12345678/);
  });

  test("yt-dlp fallback: subtitle url from the dump is fetched via the guarded fetch", async () => {
    const ctx = ctxOf(
      {
        "https://www.youtube.com/oembed": resp(OEMBED, { type: "application/json" }),
        "https://www.youtube.com/youtubei/v1/player": resp("", { type: "application/json" }),
        "https://captions.example.com/t.json3": resp(JSON3, { type: "application/json" }),
      },
      { automatic_captions: { en: [{ url: "https://captions.example.com/t.json3", ext: "json3" }] } },
    );
    const out = await youtubeAdapter.fetch(new URL("https://www.youtube.com/watch?v=abc12345678"), ctx);
    assert.equal(out.extra?.transcript, "yt-dlp");
    assert.match(out.body, /## 字幕/);
  });
});

// ── shared pieces + integration ───────────────────────────────────────

describe("subtitle/ytdlp helpers", () => {
  test("parseJson3 joins segs and lines", () => {
    assert.equal(parseJson3(JSON3), "hello world\nsecond line");
    assert.equal(parseJson3("not json"), null);
  });
  test("parseBilibiliSubtitle joins body lines", () => {
    assert.equal(parseBilibiliSubtitle(JSON.stringify({ body: [{ content: "a" }, { content: "b" }] })), "a\nb");
  });
  test("pickSubtitleUrl prefers manual subs, zh, then json3 ext", () => {
    const url = pickSubtitleUrl({
      subtitles: { "zh-Hans": [{ url: "https://x/zh.json3", ext: "json3" }] },
      automatic_captions: { en: [{ url: "https://x/en.vtt", ext: "vtt" }] },
    });
    assert.equal(url, "https://x/zh.json3");
  });
  test("formatDuration handles hours and zero", () => {
    assert.equal(formatDuration(3671), "1:01:11");
    assert.equal(formatDuration(0), undefined);
  });
  test("formatVideoBody omits empty sections", () => {
    const body = formatVideoBody({ title: "t", url: "https://u" });
    assert.doesNotMatch(body, /简介|字幕/);
  });
});

describe("ingestUrl adapter integration", () => {
  test("registered adapter order: wechat, bilibili, youtube", () => {
    assert.deepEqual(ADAPTERS.map((a) => a.name), ["wechat", "bilibili", "youtube"]);
  });

  test("a bilibili URL routes through the adapter and writes via=bilibili with transcript frontmatter", async () => {
    const routes = {
      "https://api.bilibili.com/x/web-interface/view": resp(BILI_VIEW, { type: "application/json" }),
    };
    const res = await ingestUrl("https://www.bilibili.com/video/BV1xx411c7mD", {
      fetchImpl: async (url) => {
        const key = Object.keys(routes).find((k) => url.startsWith(k));
        if (!key) throw new Error(`unexpected fetch: ${url}`);
        return routes[key as keyof typeof routes]!.clone();
      },
      ytDlpDumpJson: async () => null,
    });
    assert.equal(res.via, "bilibili");
    assert.equal(res.entry.origin, "web");
    assert.match(res.entry.extra?.transcript ?? "", /^unavailable/);
    assert.equal(res.entry.title, "从零实现倒排索引");
  });
});
