import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  FOCUS_MIN_OVERLAP,
  pickFocusedDesire,
  recentUserText,
  tokenize,
} from "./desire-focus.js";
import type { DesireEntry } from "./types.js";
import type { StoredMessage } from "../types.js";

function d(slug: string, what: string, why = ""): DesireEntry {
  return { slug, what, why, actionable: true, bornAt: "2026-01-01T00:00:00.000Z" };
}

describe("tokenize", () => {
  test("keeps latin words ≥3 chars and drops stopwords", () => {
    const t = tokenize("I want to learn Rust for systems programming");
    assert.ok(t.has("learn"));
    assert.ok(t.has("rust"));
    assert.ok(t.has("systems"));
    assert.ok(t.has("programming"));
    assert.ok(!t.has("want"), "stopword dropped");
    assert.ok(!t.has("to"), "short token dropped");
  });

  test("emits CJK bigrams within a run", () => {
    const t = tokenize("学习编程");
    assert.ok(t.has("学习"));
    assert.ok(t.has("习编"));
    assert.ok(t.has("编程"));
  });
});

describe("pickFocusedDesire", () => {
  const desires = [
    d("learn-rust", "learn Rust", "systems programming fluency"),
    d("write-novel", "write a novel", "tell a story about the sea"),
  ];

  test("surfaces the desire the conversation is clearly about", () => {
    const text = "can you help me debug this Rust borrow checker error in my systems code";
    assert.equal(pickFocusedDesire(desires, text)?.slug, "learn-rust");
  });

  test("returns null when nothing matches (→ caller falls back to recency)", () => {
    assert.equal(pickFocusedDesire(desires, "what's the weather tomorrow"), null);
  });

  test("returns null on a weak (single-token) match, below the threshold", () => {
    // Only "rust" overlaps → 1 < FOCUS_MIN_OVERLAP.
    assert.equal(FOCUS_MIN_OVERLAP, 2);
    assert.equal(pickFocusedDesire(desires, "there's rust on my bike"), null);
  });

  test("returns null on a tie (no single desire is clearly the subject)", () => {
    const tie = [
      d("a", "alpha beta", "gamma delta"),
      d("b", "alpha beta", "gamma delta"),
    ];
    assert.equal(pickFocusedDesire(tie, "alpha beta gamma"), null);
  });

  test("works cross-lingually on Chinese via CJK bigrams", () => {
    const zh = [
      d("learn-rust", "学习 Rust 编程", "掌握系统级编程"),
      d("write-novel", "写一本小说", "讲一个关于海的故事"),
    ];
    // Conversation in Chinese about programming → matches the rust desire.
    assert.equal(pickFocusedDesire(zh, "我想学习编程，尤其是系统编程")?.slug, "learn-rust");
  });

  test("empty conversation text → null", () => {
    assert.equal(pickFocusedDesire(desires, ""), null);
  });
});

describe("recentUserText", () => {
  const mk = (role: StoredMessage["role"], text: string): StoredMessage =>
    ({ role, content: [{ type: "text", text }] }) as StoredMessage;

  test("joins the last N user messages, ignoring assistant turns", () => {
    const history: StoredMessage[] = [
      mk("user", "first"),
      mk("assistant", "reply"),
      mk("user", "second"),
      mk("user", "third"),
    ];
    const text = recentUserText(history, 2);
    assert.ok(text.includes("second"));
    assert.ok(text.includes("third"));
    assert.ok(!text.includes("first"), "older than the last 2 user msgs");
    assert.ok(!text.includes("reply"), "assistant turns excluded");
  });

  test("handles string content and empty history", () => {
    assert.equal(recentUserText([]), "");
    const history = [{ role: "user", content: "plain string" } as StoredMessage];
    assert.ok(recentUserText(history).includes("plain string"));
  });
});
