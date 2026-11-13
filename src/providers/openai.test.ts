import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { OpenAIProvider } from "./openai.js";
import type { ProviderRunOpts } from "./types.js";
import { foldUsage } from "../web/gateway.js";
import { costMicroUSD } from "../billing/prices.js";

/**
 * Signal passthrough tests. The OpenAI SDK takes per-request options as the
 * second argument of `chat.completions.create(params, options)`, with
 * `options.signal` cancelling the in-flight request. We swap in a fake
 * client and assert the provider hands its `opts.signal` through there.
 */

interface Captured {
  params?: Record<string, unknown>;
  options?: { signal?: AbortSignal };
}

type Chunk = Record<string, unknown>;

function makeFakeClient(captured: Captured, chunks: Chunk[]) {
  return {
    chat: {
      completions: {
        create: async (params: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
          captured.params = params;
          captured.options = options;
          return (async function* () {
            yield* chunks;
          })();
        },
      },
    },
  };
}

const TEXT_CHUNKS: Chunk[] = [
  { choices: [{ delta: { content: "hel" } }] },
  { choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] },
  { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
];

function baseOpts(signal?: AbortSignal): ProviderRunOpts {
  return {
    model: "gpt-test",
    systemPrompt: "sys",
    tools: [],
    messages: [{ role: "user", content: "hi" }],
    signal,
  };
}

describe("OpenAIProvider — abort signal passthrough", () => {
  test("chat.completions.create receives {signal} as request options (2nd arg)", async () => {
    const provider = new OpenAIProvider({ apiKey: "test-key" });
    const captured: Captured = {};
    (provider as unknown as { client: unknown }).client = makeFakeClient(captured, TEXT_CHUNKS);
    const ac = new AbortController();

    const result = await provider.runTurn(baseOpts(ac.signal));

    assert.equal(captured.options?.signal, ac.signal);
    assert.equal(captured.params?.model, "gpt-test");
    assert.equal(result.stopReason, "end_turn");
    assert.deepEqual(result.content, [{ type: "text", text: "hello", citations: null }]);
    assert.equal(result.usage.inputTokens, 5);
  });

  test("no signal in opts → request options carry signal: undefined (SDK accepts)", async () => {
    const provider = new OpenAIProvider({ apiKey: "test-key" });
    const captured: Captured = {};
    (provider as unknown as { client: unknown }).client = makeFakeClient(captured, TEXT_CHUNKS);

    await provider.runTurn(baseOpts());

    assert.equal(captured.options?.signal, undefined);
  });
});

describe("OpenAIProvider — empty turns", () => {
  test("a turn with neither text nor tool calls yields content: [] (agent loop must filter it)", async () => {
    const provider = new OpenAIProvider({ apiKey: "test-key" });
    const captured: Captured = {};
    (provider as unknown as { client: unknown }).client = makeFakeClient(captured, [
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);

    const result = await provider.runTurn(baseOpts());

    assert.deepEqual(result.content, []);
    assert.equal(result.stopReason, "end_turn");
  });
});

describe("OpenAIProvider — usage", () => {
  test("the cached prefix is split out of prompt_tokens, so it is priced once", async () => {
    const provider = new OpenAIProvider({ apiKey: "test-key" });
    (provider as unknown as { client: unknown }).client = makeFakeClient({}, [
      { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
      {
        choices: [],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 800 },
        },
      },
    ]);

    const { usage } = await provider.runTurn(baseOpts());

    assert.deepEqual(usage, {
      inputTokens: 200,
      outputTokens: 50,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
    });
    // The hosted gateway folds the same usage block for the same account; the
    // two paths have to agree, or one of them is billing the cache twice.
    assert.deepEqual(
      foldUsage(
        "openai",
        {
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 50,
            prompt_tokens_details: { cached_tokens: 800 },
          },
        },
        { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      ),
      usage,
    );
    // Priced as 200 uncached + 800 cached + 50 out — not as the 1000-token
    // prompt at the input rate with the cached 800 charged again on top.
    const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const cost = (u: Partial<typeof zero>) => costMicroUSD("gpt-4o", { ...zero, ...u });
    assert.equal(
      costMicroUSD("gpt-4o", usage),
      cost({ inputTokens: 200 }) + cost({ cacheReadTokens: 800 }) + cost({ outputTokens: 50 }),
    );
    assert.ok(costMicroUSD("gpt-4o", usage) < cost({ ...usage, inputTokens: 1000 }));
  });
});
