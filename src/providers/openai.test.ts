import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { OpenAIProvider } from "./openai.js";
import type { ProviderRunOpts } from "./types.js";

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
        create: async (
          params: Record<string, unknown>,
          options?: { signal?: AbortSignal },
        ) => {
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
    (provider as unknown as { client: unknown }).client = makeFakeClient(
      captured,
      TEXT_CHUNKS,
    );
    const ac = new AbortController();

    const result = await provider.runTurn(baseOpts(ac.signal));

    assert.equal(captured.options?.signal, ac.signal);
    assert.equal(captured.params?.model, "gpt-test");
    assert.equal(result.stopReason, "end_turn");
    assert.deepEqual(result.content, [
      { type: "text", text: "hello", citations: null },
    ]);
    assert.equal(result.usage.inputTokens, 5);
  });

  test("no signal in opts → request options carry signal: undefined (SDK accepts)", async () => {
    const provider = new OpenAIProvider({ apiKey: "test-key" });
    const captured: Captured = {};
    (provider as unknown as { client: unknown }).client = makeFakeClient(
      captured,
      TEXT_CHUNKS,
    );

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
