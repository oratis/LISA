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
  config?: { abortSignal?: AbortSignal; systemInstruction?: string; toolConfig?: unknown };
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
    candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }],
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
    (provider as unknown as { client: unknown }).client = makeFakeClient(captured, TEXT_CHUNKS);
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
    (provider as unknown as { client: unknown }).client = makeFakeClient(captured, TEXT_CHUNKS);

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

test("Gemini meters thinking output and cached input without double counting", async () => {
  const provider = new GeminiProvider({ apiKey: "test-key" });
  (provider as unknown as { client: unknown }).client = makeFakeClient({}, [
    { candidates: [{ content: { parts: [{ text: "hi" }] } }] },
    {
      usageMetadata: {
        promptTokenCount: 100,
        cachedContentTokenCount: 60,
        candidatesTokenCount: 12,
        thoughtsTokenCount: 28,
      },
    },
  ]);
  const result = await provider.runTurn(baseOpts());
  assert.deepEqual(result.usage, {
    inputTokens: 40,
    outputTokens: 40,
    cacheReadTokens: 60,
    cacheWriteTokens: 0,
  });
  assert.equal(result.content[0].type === "text" && result.content[0].text, "hi");
});

test("Gemini uses validated tools and preserves the tool-result round trip", async () => {
  const provider = new GeminiProvider({ apiKey: "test-key" });
  const captured: { params?: CapturedParams } = {};
  (provider as unknown as { client: unknown }).client = makeFakeClient(captured, [
    {
      candidates: [
        {
          content: { parts: [{ functionCall: { name: "kb_list", args: {} } }] },
          finishReason: "STOP",
        },
      ],
    },
  ]);
  const opts = {
    ...baseOpts(),
    tools: [
      {
        name: "kb_list",
        description: "List entries",
        inputSchema: { type: "object" as const, properties: {} },
        execute: async () => "empty",
      },
    ],
  };
  const result = await provider.runTurn(opts);
  assert.equal(result.stopReason, "tool_use");
  assert.deepEqual(captured.params?.config?.toolConfig, {
    functionCallingConfig: { mode: "VALIDATED" },
  });
  const call = result.content[0];
  assert.equal(call.type, "tool_use");
  if (call.type !== "tool_use") throw new Error("Expected a tool call");
  assert.equal(call.name, "kb_list");
  assert.ok(call.id);
  (provider as unknown as { client: unknown }).client = makeFakeClient(captured, TEXT_CHUNKS);
  await provider.runTurn({
    ...opts,
    messages: [
      ...opts.messages,
      { role: "assistant", content: result.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "empty" }] },
    ],
  });
  assert.deepEqual((captured.params?.contents as Array<{ parts: unknown[] }>)?.at(-1)?.parts, [
    { functionResponse: { id: call.id, name: "kb_list", response: { output: "empty" } } },
  ]);
});

test("Gemini surfaces malformed function calls instead of silent empty success", async () => {
  const provider = new GeminiProvider({ apiKey: "test-key" });
  (provider as unknown as { client: unknown }).client = makeFakeClient({}, [
    { candidates: [{ finishReason: "MALFORMED_FUNCTION_CALL" }] },
  ]);
  await assert.rejects(provider.runTurn(baseOpts()), /could not form a valid tool call/);
});
