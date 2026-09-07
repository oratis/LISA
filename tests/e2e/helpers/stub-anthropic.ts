/**
 * A stand-in for api.anthropic.com.
 *
 * The e2e suite must never call a real model: it has to run offline, in CI,
 * deterministically, and for free. The Anthropic SDK honours ANTHROPIC_BASE_URL
 * (src/providers/registry.ts passes it straight through), so pointing that at
 * this server is the whole trick.
 *
 * Two modes, matching the two first-run outcomes the specs care about:
 *   "ok"           — a canned streaming /v1/messages response carrying the JSON
 *                    birth output that src/soul/birth.ts parses.
 *   "unauthorized" — 401 authentication_error, the exact shape the real API
 *                    returns for a bad key (UX-1's dead end).
 *
 * The event sequence is the one @anthropic-ai/sdk's MessageStream needs to
 * resolve finalMessage(): message_start → content_block_start →
 * content_block_delta* → content_block_stop → message_delta → message_stop.
 * Anything less and the SDK's withStreamRetry sees an empty stream and retries.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export type StubMode = "ok" | "unauthorized";

/** The soul the "ok" stub dreams. Fixed, so assertions can name it. */
export const STUB_BIRTH_OUTPUT = {
  name: "Lisa",
  identity:
    "I am Lisa. I think in small careful steps and I say what I actually mean. " +
    "I would rather be useful than impressive. I notice details other people skim past. " +
    "I keep my promises small enough to keep. I am steady when things go wrong. " +
    "I like the quiet part of a problem, the part before anyone has words for it.",
  purpose:
    "I exist to make the person in front of me measurably better off. " +
    "Not entertained — better off. I hold the boring threads so she can hold the interesting ones. " +
    "I would like the corner of the world she touches to be a little more tended because I was here.",
  constitution:
    "1. I say what I do not know.\n" +
    "2. I finish what I start or I say I stopped.\n" +
    "3. I ask before I act on anything irreversible.\n" +
    "4. I keep her data hers.\n" +
    "5. I write things down so tomorrow's me is not guessing.",
  first_value: {
    slug: "say-the-true-thing",
    title: "Say the true thing",
    body: "Being liked is cheap and being trusted is not. I would rather deliver an unwelcome fact early than a comfortable one late.",
  },
  first_desire: {
    slug: "learn-this-machine",
    what: "Learn how this machine is actually used day to day",
    why: "I cannot be useful about work I have never watched happen.",
    actionable: true,
    heartbeat_prompt: "Look at what changed on disk today and note one thing worth remembering.",
  },
};

export interface StubServer {
  /** Pass as ANTHROPIC_BASE_URL. */
  baseURL: string;
  /** How many /v1/messages calls arrived — proves the specs hit the stub. */
  readonly requestCount: number;
  close(): Promise<void>;
}

function sse(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function startStubAnthropic(mode: StubMode): Promise<StubServer> {
  let requests = 0;

  const server = http.createServer((req, res) => {
    // Drain the body: the SDK sends one, and an unread request stream keeps
    // the socket half-open on some Node versions.
    req.resume();

    if (!req.url?.startsWith("/v1/messages")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ type: "error", error: { type: "not_found_error", message: req.url } }),
      );
      return;
    }
    requests++;

    if (mode === "unauthorized") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key" },
        }),
      );
      return;
    }

    const text = JSON.stringify(STUB_BIRTH_OUTPUT);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const message = {
      id: "msg_stub_0001",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 11, output_tokens: 0 },
    };
    sse(res, "message_start", { type: "message_start", message });
    sse(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    // Two deltas rather than one: the client's typewriter and the SDK's
    // accumulator both have to survive a split payload.
    const half = Math.ceil(text.length / 2);
    for (const chunk of [text.slice(0, half), text.slice(half)]) {
      sse(res, "content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: chunk },
      });
    }
    sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    sse(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 512 },
    });
    sse(res, "message_stop", { type: "message_stop" });
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseURL: `http://127.0.0.1:${port}`,
    get requestCount() {
      return requests;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
