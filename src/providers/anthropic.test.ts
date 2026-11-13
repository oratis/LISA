import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { AnthropicProvider, anthropicUsage, modelSupportsEffort } from "./anthropic.js";
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

describe("AnthropicProvider — effort gating by model", () => {
  function runWithModelAndEffort(model: string, effort?: ProviderRunOpts["effort"]) {
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    const captured: Captured = {};
    (provider as unknown as { client: unknown }).client = {
      messages: { stream: makeFakeStream(captured) },
    };
    return provider
      .runTurn({ ...baseOpts(), model, effort })
      .then((result) => ({ captured, result }));
  }

  test("Sonnet/Opus + effort → output_config.effort is attached", async () => {
    const { captured } = await runWithModelAndEffort("claude-opus-4-8", "low");
    assert.deepEqual(captured.params?.output_config, { effort: "low" });
  });

  test("Haiku + effort → output_config omitted, call still succeeds", async () => {
    // The exact break: subagents/idle default to effort "low", and Haiku 4.5
    // 400s on output_config.effort. The gate must drop it so the SDK sends a
    // request Haiku accepts — and the turn completes normally.
    const { captured, result } = await runWithModelAndEffort("claude-haiku-4-5-20251001", "low");
    assert.equal(captured.params?.output_config, undefined);
    assert.equal(result.stopReason, "end_turn");
  });

  test("no effort → no output_config regardless of model", async () => {
    const { captured } = await runWithModelAndEffort("claude-opus-4-8");
    assert.equal(captured.params?.output_config, undefined);
  });
});

describe("modelSupportsEffort", () => {
  test("false only for the Haiku family (case-insensitive), true otherwise", () => {
    assert.equal(modelSupportsEffort("claude-haiku-4-5-20251001"), false);
    assert.equal(modelSupportsEffort("claude-haiku-4-5"), false);
    assert.equal(modelSupportsEffort("Claude-HAIKU-4-5"), false);
    assert.equal(modelSupportsEffort("claude-opus-4-8"), true);
    assert.equal(modelSupportsEffort("claude-sonnet-5"), true);
    assert.equal(modelSupportsEffort("claude-3-5-sonnet-20241022"), true);
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

/**
 * What actually goes over the wire, through the real SDK against a local stub.
 * Which header carries the credential, and which API version is asked for, are
 * decided inside the SDK and have changed between its majors (1.0 moved the
 * API key to `Authorization` and the version to 2026-10-21), so they are
 * pinned here: an SDK bump that changes either one fails a test instead of
 * changing requests unnoticed.
 */
describe("AnthropicProvider — request headers on the wire", () => {
  interface Seen {
    url?: string;
    headers: http.IncomingHttpHeaders;
    body: Record<string, unknown>;
  }

  /** One turn against a stub that streams a minimal message; returns the request it got. */
  async function sendTurn(
    auth: { apiKey?: string; authToken?: string },
    run: Partial<ProviderRunOpts> = {},
  ): Promise<Seen> {
    let seen: Seen | undefined;
    const server = http.createServer((req, res) => {
      void respond(req, res).catch((error: Error) => res.destroy(error));
    });
    async function respond(req: http.IncomingMessage, res: http.ServerResponse) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      seen = {
        url: req.url,
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      };
      const events: Array<[string, Record<string, unknown>]> = [
        [
          "message_start",
          {
            message: {
              id: "msg_stub",
              type: "message",
              role: "assistant",
              model: "claude-test",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
        ],
        ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "hi" } }],
        ["content_block_stop", { index: 0 }],
        [
          "message_delta",
          { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        ],
        ["message_stop", {}],
      ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const [type, data] of events) {
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      }
      res.end();
    }
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const provider = new AnthropicProvider({ ...auth, baseURL: `http://127.0.0.1:${port}` });
      const result = await provider.runTurn({ ...baseOpts(), ...run });
      assert.equal(result.stopReason, "end_turn");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    assert.ok(seen, "the stub received no request");
    return seen;
  }

  test("an API key goes out in x-api-key, not as a bearer token", async () => {
    const { url, headers } = await sendTurn({ apiKey: "sk-test-key" });
    assert.equal(url, "/v1/messages");
    assert.equal(headers["x-api-key"], "sk-test-key");
    assert.equal(headers.authorization, undefined);
    assert.equal(headers["anthropic-version"], "2026-10-21");
  });

  test("an auth token goes out as Authorization: Bearer, with no x-api-key", async () => {
    // A key left in the environment must not ride along to the gateway the
    // token is for.
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-env-key";
    try {
      const { headers } = await sendTurn({ authToken: "gateway-token" });
      assert.equal(headers.authorization, "Bearer gateway-token");
      assert.equal(headers["x-api-key"], undefined);
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  test("given both, the auth token wins and the key is not sent", async () => {
    const { headers } = await sendTurn({ apiKey: "sk-test-key", authToken: "gateway-token" });
    assert.equal(headers.authorization, "Bearer gateway-token");
    assert.equal(headers["x-api-key"], undefined);
  });

  test("compaction asks for its beta by header, on the same path", async () => {
    const { url, headers, body } = await sendTurn({ apiKey: "sk-test-key" }, { compaction: true });
    assert.equal(url, "/v1/messages");
    assert.equal(headers["anthropic-beta"], "compact-2026-01-12");
    assert.equal(headers["x-api-key"], "sk-test-key");
    assert.deepEqual(body.context_management, { edits: [{ type: "compact_20260112" }] });
    // `betas` is the SDK's name for the header; it is not a body field.
    assert.equal("betas" in body, false);
  });
});

describe("anthropicUsage — the 1-hour cache-write share (#447 review)", () => {
  test("carries the 1-hour writes separately; leaves the field off when there are none", () => {
    const usage = {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 40,
      cache_creation: { ephemeral_5m_input_tokens: 15, ephemeral_1h_input_tokens: 25 },
    } as unknown as Parameters<typeof anthropicUsage>[0];
    assert.deepEqual(anthropicUsage(usage), {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
      cacheWrite1hTokens: 25,
    });
    const fiveMinute = {
      input_tokens: 1,
      output_tokens: 2,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 3,
      cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 0 },
    } as unknown as Parameters<typeof anthropicUsage>[0];
    assert.equal("cacheWrite1hTokens" in anthropicUsage(fiveMinute), false);
    assert.deepEqual(anthropicUsage(undefined), {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
});
