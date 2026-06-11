import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { GeminiProvider } from "./gemini.js";
import type { ProviderRunOpts } from "./types.js";

/**
 * Signal passthrough tests. @google/genai has no per-request options
 * argument — cancellation goes through `config.abortSignal` inside the
 * `generateContentStream({model, contents, config})` params. We swap in a
 * fake client and assert the provider hands its `opts.signal` through there.
 *
 * The client is constructed lazily (dynamic import on first runTurn), so
 * pre-seeding the private `client` field skips @google/genai entirely.
 */

interface CapturedParams {
  model?: string;
  contents?: unknown;
  config?: { abortSignal?: AbortSignal; systemInstruction?: string };
}

type Chunk = Record<string, unknown>;

function makeFakeClient(captured: { params?: CapturedParams }, chunks: Chunk[]) {
  return {
    models: {
      generateContentStream: async (params: CapturedParams) => {
        captured.params = params;
        return (async function* () {
          yield* chunks;
        })();
      },
    },
  };
}

const TEXT_CHUNKS: Chunk[] = [
  {
    candidates: [
      { content: { parts: [{ text: "hi" }] }, finishReason: "STOP" },
    ],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
  },
];

function baseOpts(signal?: AbortSignal): ProviderRunOpts {
  return {
    model: "gemini-test",
    systemPrompt: "sys",
    tools: [],
    messages: [{ role: "user", content: "hi" }],
    signal,
  };
}

describe("GeminiProvider — abort signal passthrough", () => {
  test("generateContentStream receives the signal as config.abortSignal", async () => {
    const provider = new GeminiProvider({ apiKey: "test-key" });
    const captured: { params?: CapturedParams } = {};
    (provider as unknown as { client: unknown }).client = makeFakeClient(
      captured,
      TEXT_CHUNKS,
    );
    const ac = new AbortController();

    const result = await provider.runTurn(baseOpts(ac.signal));

    assert.equal(captured.params?.config?.abortSignal, ac.signal);
    assert.equal(captured.params?.model, "gemini-test");
    assert.equal(captured.params?.config?.systemInstruction, "sys");
    assert.equal(result.stopReason, "end_turn");
    assert.equal(result.usage.inputTokens, 5);
  });

  test("no signal in opts → config.abortSignal is undefined (SDK accepts)", async () => {
    const provider = new GeminiProvider({ apiKey: "test-key" });
    const captured: { params?: CapturedParams } = {};
    (provider as unknown as { client: unknown }).client = makeFakeClient(
      captured,
      TEXT_CHUNKS,
    );

    await provider.runTurn(baseOpts());

    assert.equal(captured.params?.config?.abortSignal, undefined);
  });
});

describe("GeminiProvider — lazy SDK loading", () => {
  test("constructing the provider does not build the @google/genai client", () => {
    const provider = new GeminiProvider({ apiKey: "test-key" });
    assert.equal(
      (provider as unknown as { client: unknown }).client,
      null,
      "client must stay null until the first runTurn",
    );
  });
});
