import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openaiUsage } from "./usage.js";

describe("openaiUsage", () => {
  test("prompt_tokens includes the cached prefix; inputTokens must not", () => {
    assert.deepEqual(
      openaiUsage({
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 800 },
      }),
      { inputTokens: 200, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 0 },
    );
  });

  test("no cache details ⇒ the whole prompt is uncached input", () => {
    assert.deepEqual(openaiUsage({ prompt_tokens: 5, completion_tokens: 2 }), {
      inputTokens: 5,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    assert.equal(openaiUsage({ prompt_tokens: 5, prompt_tokens_details: null }).inputTokens, 5);
  });

  test("a misreporting provider cannot drive a counter negative or non-finite", () => {
    const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    // More cached than prompt: clamp to the prompt, never below zero.
    assert.deepEqual(
      openaiUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 900 } }),
      { ...zero, cacheReadTokens: 100 },
    );
    for (const junk of [null, undefined, "usage", [], {}, { prompt_tokens: "12" }]) {
      assert.deepEqual(openaiUsage(junk), zero, JSON.stringify(junk));
    }
    assert.deepEqual(
      openaiUsage({ prompt_tokens: -5, completion_tokens: Number.NaN, prompt_tokens_details: [] }),
      zero,
    );
  });
});
