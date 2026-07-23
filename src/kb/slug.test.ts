import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { kbSlug, canonicalUrl, shortHash } from "./slug.js";

describe("kbSlug", () => {
  test("latin titles slug exactly as before", () => {
    assert.equal(kbSlug({ title: "OAuth PKCE notes" }), "oauth-pkce-notes");
  });

  test("a Chinese title gets a stable date+hash slug, not entry-<Date.now()>", () => {
    // The bug: normalizeSlug strips every non-[a-z0-9] char, so a CJK title
    // returned "" and the caller fell back to a timestamp — unstable, opaque,
    // and impossible to dedupe against.
    const a = kbSlug({ title: "知识库的设计", url: "https://x.test/a", date: "2026-07-23" });
    const b = kbSlug({ title: "知识库的设计", url: "https://x.test/a", date: "2026-07-23" });
    assert.equal(a, b, "same input → same slug");
    assert.match(a, /^2026-07-23-[0-9a-f]{8}$/);
  });

  test("different URLs on the same day get different slugs", () => {
    const a = kbSlug({ title: "文章", url: "https://x.test/a", date: "2026-07-23" });
    const b = kbSlug({ title: "文章", url: "https://x.test/b", date: "2026-07-23" });
    assert.notEqual(a, b);
  });

  test("falls back to hashing the title when there is no URL", () => {
    const s = kbSlug({ title: "关于检索的笔记", date: "2026-01-02T03:04:05.000Z" });
    assert.match(s, /^2026-01-02-[0-9a-f]{8}$/);
  });

  test("a too-short latin title also takes the hashed form", () => {
    // "AI" normalizes to 2 chars — too thin to be a useful, collision-safe id.
    assert.match(kbSlug({ title: "AI", date: "2026-07-23" }), /^2026-07-23-[0-9a-f]{8}$/);
  });

  test("emoji-only and punctuation-only titles never produce an empty slug", () => {
    for (const title of ["🎉🎉", "!!!", "  "]) {
      assert.ok(kbSlug({ title, date: "2026-07-23" }).length > 10, title);
    }
  });

  test("the slug stays ASCII (NFD/NFC filename hazard, URLs, git paths)", () => {
    const s = kbSlug({ title: "日本語のタイトル", date: "2026-07-23" });
    // eslint-disable-next-line no-control-regex
    assert.match(s, /^[\x21-\x7e]+$/);
  });
});

describe("canonicalUrl", () => {
  test("drops utm_* and known tracking params", () => {
    assert.equal(
      canonicalUrl("https://Example.com/post?utm_source=x&utm_medium=y&id=7"),
      "https://example.com/post?id=7",
    );
  });

  test("drops the fragment and a trailing slash", () => {
    assert.equal(canonicalUrl("https://example.com/post/#section"), "https://example.com/post");
  });

  test("keeps params that carry meaning (t, from, timestamp)", () => {
    const u = canonicalUrl("https://youtu.be/abc?t=120&si=track");
    assert.match(u, /t=120/);
    assert.doesNotMatch(u, /si=/);
  });

  test("strips the bilibili/wechat app appendages that break dedupe", () => {
    const bili = canonicalUrl("https://www.bilibili.com/video/BV1x?spm_id_from=333&vd_source=abc");
    assert.equal(bili, "https://www.bilibili.com/video/BV1x");
  });

  test("two shares of the same article canonicalize identically", () => {
    const a = canonicalUrl("https://mp.weixin.qq.com/s?__biz=A&sn=B&scene=21&srcid=0101");
    const b = canonicalUrl("https://mp.weixin.qq.com/s?__biz=A&sn=B&isappinstalled=0");
    assert.equal(shortHash(a), shortHash(b));
  });

  test("an unparseable value is returned trimmed rather than thrown", () => {
    assert.equal(canonicalUrl("  not a url  "), "not a url");
  });
});
