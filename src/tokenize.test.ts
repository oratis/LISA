import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { tokenize, BASE_STOPWORDS } from "./tokenize.js";

describe("tokenize — latin (unchanged behavior)", () => {
  test("lowercases, strips punctuation, drops stopwords and 1-char tokens", () => {
    assert.deepEqual(tokenize("The OAuth flow, and PKCE!"), ["oauth", "flow", "pkce"]);
  });

  test("keeps digits and alphanumerics", () => {
    assert.deepEqual(tokenize("oauth2 rfc7636"), ["oauth2", "rfc7636"]);
  });

  test("a caller-supplied stoplist replaces the default", () => {
    const stop = new Set([...BASE_STOPWORDS, "lisa"]);
    assert.deepEqual(tokenize("lisa reads the wiki", stop), ["reads", "wiki"]);
  });
});

describe("tokenize — CJK bigrams (the bug this fixes)", () => {
  // Before this module both indexes split on whitespace only, so the whole
  // Chinese clause survived as a single token and a real query never matched.
  const DOC = "这篇公众号文章讲的是知识库的设计";

  test("a substring query shares tokens with the document", () => {
    const doc = new Set(tokenize(DOC));
    const query = tokenize("知识库");
    assert.ok(query.length > 0);
    assert.ok(
      query.some((t) => doc.has(t)),
      `no overlap between ${JSON.stringify(query)} and the document tokens`,
    );
  });

  test("the whole run is kept too, so an exact-phrase query still ranks", () => {
    assert.ok(tokenize(DOC).includes(DOC));
  });

  test("every adjacent 2-gram is emitted", () => {
    const t = tokenize("知识库");
    assert.deepEqual(t, ["知识库", "知识", "识库"]);
  });

  test("a 2-char word is emitted once, not double-counted", () => {
    assert.deepEqual(tokenize("设计"), ["设计"]);
  });

  test("a single CJK char survives (it is often a whole word)", () => {
    assert.deepEqual(tokenize("书"), ["书"]);
  });

  test("an unrelated CJK query does not match", () => {
    const doc = new Set(tokenize(DOC));
    assert.ok(!tokenize("苹果手机").some((t) => doc.has(t)));
  });

  test("Japanese kana is indexed rather than dropped", () => {
    // The old character class kept only U+4E00–U+9FFF, so kana became spaces
    // and Japanese text tokenized to nothing at all.
    assert.ok(tokenize("ひらがな").length > 0);
  });
});

describe("tokenize — mixed scripts", () => {
  test("splits at the latin/CJK boundary instead of making one blob", () => {
    assert.deepEqual(tokenize("gpt模型"), ["gpt", "模型"]);
  });

  test("handles latin embedded between CJK runs", () => {
    assert.deepEqual(tokenize("用llm做检索"), ["用", "llm", "做检索", "做检", "检索"]);
  });

  test("CJK punctuation separates runs", () => {
    const t = tokenize("检索，排序。");
    assert.ok(t.includes("检索") && t.includes("排序"));
    assert.ok(!t.some((x) => x.includes("，")));
  });
});
