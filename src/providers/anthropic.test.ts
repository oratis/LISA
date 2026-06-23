import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AnthropicProvider } from "./anthropic.js";
import type { ProviderRunOpts } from "./types.js";

/**
 * Signal passthrough tests. The Anthropic SDK takes per-request options as
 * the second argument of `messages.stream(params, options)` (same for
 * `beta.messages.stream`), with `options.signal` cancelling the in-flight
 * request. We swap in a fake client and assert the provider hands its
 * `opts.signal` through in that exact position.
 */

interface Captured {
  params?: Record<string, unknown>;
  options?: { signal?: AbortSignal };
}

function fakeFinalMessage() {
  return {
    content: [{ type: "text", text: "hi", citations: null }],
    stop_reason: "end_turn",
    usage: {
      input_tokens: 1,
      output_tokens: 2,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 4,
    },
  };
}

function makeFakeStream(captured: Captured) {
  return (params: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
    captured.params = params;
    captured.options = options;
    return {
      on: () => {},
      finalMessage: async () => fakeFinalMessage(),
    };
  };
}

function baseOpts(signal?: AbortSignal): ProviderRunOpts {
  return {
    model: "claude-test",
    systemPrompt: "sys",
    tools: [],
    messages: [{ role: "user", content: "hi" }],
    signal,
  };
}

describe("AnthropicProvider — abort signal passthrough", () => {
  test("messages.stream receives {signal} as request options (2nd arg)", async () => {
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    const captured: Captured = {};
    (provider as unknown as { client: unknown }).client = {
      messages: { stream: makeFakeStream(captured) },
    };
    const ac = new AbortController();

    const result = await provider.runTurn(baseOpts(ac.signal));

    assert.equal(captured.options?.signal, ac.signal);
    // Params stay in the first argument, untouched by the options split.
    assert.equal(captured.params?.model, "claude-test");
    assert.equal(result.stopReason, "end_turn");
    assert.equal(result.usage.cacheReadTokens, 3);
  });

  test("compaction path (beta.messages.stream) also receives {signal}", async () => {
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    const captured: Captured = {};
    (provider as unknown as { client: unknown }).client = {
      beta: { messages: { stream: makeFakeStream(captured) } },
    };
    const ac = new AbortController();

    await provider.runTurn({ ...baseOpts(ac.signal), compaction: true });

    assert.equal(captured.options?.signal, ac.signal);
    assert.deepEqual(captured.params?.betas, ["compact-2026-01-12"]);
  });

  test("no signal in opts → request options carry signal: undefined (SDK accepts)", async () => {
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    const captured: Captured = {};
    (provider as unknown as { client: unknown }).client = {
      messages: { stream: makeFakeStream(captured) },
    };

    await provider.runTurn(baseOpts());

    assert.equal(captured.options?.signal, undefined);
  });
});

describe("AnthropicProvider — transient empty-stream retry", () => {
  test("retries when finalMessage dies with no chunks, then succeeds", async () => {
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    let calls = 0;
    (provider as unknown as { client: unknown }).client = {
      messages: {
        stream: () => ({
          on: () => {},
          finalMessage: async () => {
            calls++;
            if (calls === 1) {
              throw new Error("request ended without sending any chunks");
            }
            return fakeFinalMessage();
          },
        }),
      },
    };

    const result = await provider.runTurn(baseOpts());

    assert.equal(calls, 2); // failed once, reopened the stream, succeeded
    assert.equal(result.stopReason, "end_turn");
  });

  test("does NOT retry once a text delta has been forwarded", async () => {
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    let calls = 0;
    (provider as unknown as { client: unknown }).client = {
      messages: {
        stream: () => ({
          // Emit a delta synchronously on registration to mark output started.
          on: (event: string, cb: (t: string) => void) => {
            if (event === "text") cb("partial");
          },
          finalMessage: async () => {
            calls++;
            throw new Error("request ended without sending any chunks");
          },
        }),
      },
    };

    const deltas: string[] = [];
    await assert.rejects(
      provider.runTurn({
        ...baseOpts(),
        handlers: { onTextDelta: (t) => deltas.push(t) },
      }),
      /any chunks/,
    );

    assert.equal(calls, 1); // surfaced, not retried — output already streamed
    assert.deepEqual(deltas, ["partial"]);
  });
});
