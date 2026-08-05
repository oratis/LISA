import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { autolink } from "./autolink.js";

const NODES = [
  { slug: "oauth", title: "OAuth" },
  { slug: "oauth-pkce", title: "OAuth PKCE" },
  { slug: "2026-07-21-9f3ac1de", title: "向量检索" },
];

describe("kb autolink (conservative title → [[link]])", () => {
  test("links a whole-word title occurrence (display text keeps the casing)", () => {
    assert.equal(
      autolink("We use OAuth here.", [{ slug: "oauth", title: "OAuth" }]),
      "We use [[oauth|OAuth]] here.",
    );
    assert.equal(
      autolink("try graphs", [{ slug: "graphs", title: "graphs" }]),
      "try [[graphs]]",
    );
  });

  test("title ≠ slug keeps the prose readable via display text", () => {
    assert.equal(
      autolink("先做向量检索再排序。", NODES),
      "先做[[2026-07-21-9f3ac1de|向量检索]]再排序。",
    );
  });

  test("first occurrence only", () => {
    assert.equal(
      autolink("OAuth then OAuth again.", [{ slug: "oauth", title: "OAuth" }]),
      "[[oauth|OAuth]] then OAuth again.",
    );
  });

  test("longest title claims the span (no nested link inside it)", () => {
    const out = autolink("Read about OAuth PKCE flows.", NODES);
    assert.equal(out, "Read about [[oauth-pkce|OAuth PKCE]] flows.");
  });

  test("no partial-word matches for ASCII", () => {
    assert.equal(
      autolink("The OAuthClient class.", [{ slug: "oauth", title: "OAuth" }]),
      "The OAuthClient class.",
    );
  });

  test("skips fenced code, inline code, and existing links", () => {
    const body = [
      "```",
      "OAuth in a fence",
      "```",
      "Inline `OAuth` stays.",
      "Existing [[oauth]] stays, and [OAuth docs](https://x) stays.",
    ].join("\n");
    assert.equal(autolink(body, [{ slug: "oauth", title: "OAuth" }]), body);
  });

  test("skips blank-line-preceded indented code blocks", () => {
    const body = "Intro.\n\n    OAuth inside indented code\n\nOAuth outside.";
    assert.equal(
      autolink(body, [{ slug: "oauth", title: "OAuth" }]),
      "Intro.\n\n    OAuth inside indented code\n\n[[oauth|OAuth]] outside.",
    );
  });

  test("indented list continuations are NOT treated as code", () => {
    const body = "- item\n\n    - OAuth in a nested list";
    assert.match(autolink(body, [{ slug: "oauth", title: "OAuth" }]), /\[\[oauth\|OAuth\]\]/);
  });

  test("too-short titles never link", () => {
    const body = "Go is a language. 书 is a book.";
    assert.equal(
      autolink(body, [
        { slug: "go", title: "Go" },
        { slug: "shu", title: "书" },
      ]),
      body,
    );
  });

  test("unterminated fence protects to end of body", () => {
    const body = "```\nOAuth never closed";
    assert.equal(autolink(body, [{ slug: "oauth", title: "OAuth" }]), body);
  });

  test("empty inputs are no-ops", () => {
    assert.equal(autolink("", NODES), "");
    assert.equal(autolink("OAuth", []), "OAuth");
  });
});
