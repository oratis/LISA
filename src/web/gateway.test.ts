import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { planUpstream, foldUsage, usageFromJson, estimateUsageFromBytes } = await import("./gateway.js");
const { managedConfig, hasCredentialsForModel } = await import("../providers/registry.js");
const { costMicroUSD } = await import("../billing/prices.js");

const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe("planUpstream", () => {
  test("anthropic face swaps in the real key + version passthrough", () => {
    const plan = planUpstream("anthropic", "/v1/messages", "claude-sonnet-4-6",
      { "anthropic-version": "2024-01-01" }, { ANTHROPIC_API_KEY: "sk-real" });
    assert.equal(plan?.url, "https://api.anthropic.com/v1/messages");
    assert.equal(plan?.headers["x-api-key"], "sk-real");
    assert.equal(plan?.headers["anthropic-version"], "2024-01-01");
  });

  test("openai face routes GLM through its preset with the ZHIPU key", () => {
    const plan = planUpstream("openai", "/chat/completions", "glm-4.6", {}, { ZHIPU_API_KEY: "zk" });
    assert.ok(plan?.url.includes("bigmodel.cn"));
    assert.equal(plan?.headers.authorization, "Bearer zk");
  });

  test("no operator key for the face → null (503 upstream)", () => {
    assert.equal(planUpstream("anthropic", "/v1/messages", "claude-3", {}, {}), null);
    assert.equal(planUpstream("openai", "/chat/completions", "glm-4.6", {}, {}), null);
  });
});

describe("usage tee-parsing", () => {
  test("anthropic stream: message_start + message_delta accumulate", () => {
    let acc = foldUsage("anthropic", {
      type: "message_start",
      message: { usage: { input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 10, output_tokens: 1 } },
    }, ZERO);
    acc = foldUsage("anthropic", { type: "message_delta", usage: { output_tokens: 250 } }, acc);
    assert.deepEqual(acc, { inputTokens: 100, outputTokens: 251, cacheReadTokens: 40, cacheWriteTokens: 10 });
  });

  test("openai stream: only the final usage chunk counts; content chunks are neutral", () => {
    let acc = foldUsage("openai", { choices: [{ delta: { content: "hi" } }], usage: null }, ZERO);
    assert.deepEqual(acc, ZERO);
    acc = foldUsage("openai", { usage: { prompt_tokens: 42, completion_tokens: 88 } }, acc);
    assert.equal(acc.inputTokens, 42);
    assert.equal(acc.outputTokens, 88);
  });

  test("non-streaming JSON bodies for both faces", () => {
    assert.deepEqual(
      usageFromJson("anthropic", { usage: { input_tokens: 5, output_tokens: 7 } }),
      { inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
    );
    assert.equal(usageFromJson("openai", { usage: { prompt_tokens: 3, completion_tokens: 4 } }).outputTokens, 4);
  });
});

describe("missing-usage debit floor (#264)", () => {
  test("estimates tokens from bytes so a 2xx with no usage is never free", () => {
    const u = estimateUsageFromBytes(4000, 800);
    assert.equal(u.inputTokens, 1000);
    assert.equal(u.outputTokens, 200);
    assert.equal(u.cacheReadTokens, 0);
    assert.equal(u.cacheWriteTokens, 0);
    // a partial token still costs one — never round a real turn down to free
    const tiny = estimateUsageFromBytes(1, 1);
    assert.equal(tiny.inputTokens, 1);
    assert.equal(tiny.outputTokens, 1);
    // and the priced result is strictly positive
    assert.ok(costMicroUSD("glm-4.6", tiny) > 0);
    // degenerate inputs don't produce NaN or negative usage
    assert.deepEqual(estimateUsageFromBytes(0, 0), ZERO);
    assert.deepEqual(estimateUsageFromBytes(-5, -5), ZERO);
  });
});

describe("managed mode resolution", () => {
  test("managedConfig parses env; empty session → null; base normalized", () => {
    assert.equal(managedConfig({}), null);
    assert.equal(managedConfig({ LISA_MANAGED_SESSION: "  " }), null);
    const m = managedConfig({ LISA_MANAGED_SESSION: "s1.x.y", LISA_MANAGED_BASE: "https://cloud.example.com/" });
    assert.equal(m?.base, "https://cloud.example.com");
    assert.equal(managedConfig({ LISA_MANAGED_SESSION: "t" })?.base, "https://cloud.meetlisa.ai");
  });

  test("a managed session satisfies the key gate for gateway-served models", () => {
    const env = { LISA_MANAGED_SESSION: "s1.x.y" };
    assert.equal(hasCredentialsForModel("glm-4.6", env), true);
    assert.equal(hasCredentialsForModel("claude-sonnet-4-6", env), true);
    assert.equal(hasCredentialsForModel("gemini-2.0-pro", env), false);
    assert.equal(hasCredentialsForModel("glm-4.6", {}), false);
  });
});
