import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { FallbackProvider } from "./fallback.js";
import { resolveDefaultModel } from "./registry.js";
import { DEFAULT_MODEL } from "../llm.js";
import type { Provider, ProviderResult, ProviderRunOpts } from "./types.js";

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

function okResult(text: string): ProviderResult {
  return {
    content: [{ type: "text", text, citations: null } as Anthropic.TextBlock],
    stopReason: "end_turn",
    usage: ZERO_USAGE,
  };
}
function textOf(r: ProviderResult): string {
  return (r.content[0] as Anthropic.TextBlock).text;
}
function fakeProvider(behavior: (opts: ProviderRunOpts) => Promise<ProviderResult>): Provider {
  return { name: "fake", runTurn: behavior };
}
function baseOpts(): ProviderRunOpts {
  return { model: "primary", systemPrompt: "s", tools: [], messages: [] };
}

describe("FallbackProvider", () => {
  test("uses the primary when it succeeds; the fallback is never called", async () => {
    const calls: string[] = [];
    const fp = new FallbackProvider([
      { model: "m1", provider: fakeProvider(async (o) => (calls.push(o.model), okResult("from m1"))) },
      { model: "m2", provider: fakeProvider(async (o) => (calls.push(o.model), okResult("from m2"))) },
    ]);
    assert.equal(textOf(await fp.runTurn(baseOpts())), "from m1");
    assert.deepEqual(calls, ["m1"]);
  });

  test("falls through on error, running each link with its own model id", async () => {
    const calls: string[] = [];
    const fp = new FallbackProvider([
      { model: "m1", provider: fakeProvider(async (o) => { calls.push(o.model); throw new Error("boom"); }) },
      { model: "m2", provider: fakeProvider(async (o) => (calls.push(o.model), okResult("from m2"))) },
    ]);
    assert.equal(textOf(await fp.runTurn(baseOpts())), "from m2");
    assert.deepEqual(calls, ["m1", "m2"]);
  });

  test("throws the last error when every link fails", async () => {
    const fp = new FallbackProvider([
      { model: "m1", provider: fakeProvider(async () => { throw new Error("first"); }) },
      { model: "m2", provider: fakeProvider(async () => { throw new Error("last"); }) },
    ]);
    await assert.rejects(fp.runTurn(baseOpts()), /last/);
  });

  test("an empty chain is a programmer error", () => {
    assert.throws(() => new FallbackProvider([]), /at least one/);
  });
});

describe("resolveDefaultModel — single-key auto-detect", () => {
  const KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "LISA_MODEL"];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("an explicit LISA_MODEL wins, even over an Anthropic key", () => {
    process.env.LISA_MODEL = "qwen2.5-coder:32b";
    process.env.ANTHROPIC_API_KEY = "x";
    assert.equal(resolveDefaultModel(), "qwen2.5-coder:32b");
  });
  test("an Anthropic key → the canonical default", () => {
    process.env.ANTHROPIC_API_KEY = "x";
    assert.equal(resolveDefaultModel(), DEFAULT_MODEL);
  });
  test("only an OpenAI key → gpt-4o", () => {
    process.env.OPENAI_API_KEY = "x";
    assert.equal(resolveDefaultModel(), "gpt-4o");
  });
  test("nothing configured → the canonical default", () => {
    assert.equal(resolveDefaultModel(), DEFAULT_MODEL);
  });
});
