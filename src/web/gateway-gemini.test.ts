/**
 * The gateway's Gemini face: routing, the request allow-list, metering from
 * `usageMetadata`, and the billing path end to end (admission → reservation →
 * settlement → reconciliation) over a real HTTP socket.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-gw-gemini-"));
process.env.LISA_HOME = TMP;
delete process.env.LISA_FIRESTORE;
process.env.LISA_LOG_FORMAT = "text";

import type { AccountRecord } from "./accounts.js";
import type { AdmissionDependencies } from "../billing/admission.js";
import type { SettlementDeps, UsageEvent } from "../billing/outbox.js";
import type { ProviderUsage } from "../providers/types.js";
import type { GatewayDependencies } from "./gateway.js";

const {
  clampGeminiOutput,
  geminiModelServed,
  geminiUsageToProvider,
  handleGateway,
  mergeGeminiUsage,
  parseGeminiRoute,
  planUpstream,
  usageFromGeminiJson,
  validateGeminiRequest,
  ZERO_GEMINI_USAGE,
} = await import("./gateway.js");
const { admitInference } = await import("../billing/admission.js");
const { MemoryOutboxStore, settleUsage } = await import("../billing/outbox.js");
const { reconcileOnce } = await import("../billing/reconcile.js");
const { costMicroUSD, priceForModel } = await import("../billing/prices.js");
const { BillingStateError } = await import("../billing/quota.js");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const MODEL = "gemini-2.5-flash";
const ACCT: AccountRecord = {
  uid: "em-gateway-gemini-0001",
  kind: "email",
  email: "g@example.com",
  createdAt: 1,
  lastLoginAt: 1,
  verified: true,
  sessionVersion: 0,
};
const OPERATOR_KEY = "operator-gemini-key";
const ENV = { GEMINI_API_KEY: OPERATOR_KEY };

// ── pure pieces ─────────────────────────────────────────────────────────────

describe("parseGeminiRoute", () => {
  test("accepts generateContent and streamGenerateContent, with or without alt=sse", () => {
    assert.deepEqual(parseGeminiRoute(`/gw/gemini/v1beta/models/${MODEL}:generateContent`), {
      version: "v1beta",
      model: MODEL,
      method: "generateContent",
      sse: false,
      upstreamPath: `/v1beta/models/${MODEL}:generateContent`,
    });
    assert.deepEqual(
      parseGeminiRoute(`/gw/gemini/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`),
      {
        version: "v1beta",
        model: MODEL,
        method: "streamGenerateContent",
        sse: true,
        upstreamPath: `/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`,
      },
    );
    assert.equal(parseGeminiRoute(`/gw/gemini/v1/models/${MODEL}:generateContent`)?.version, "v1");
  });

  for (const bad of [
    `/gw/gemini/v1beta/models/${MODEL}:countTokens`,
    `/gw/gemini/v1beta/models/${MODEL}:embedContent`,
    `/gw/gemini/v1beta/models/${MODEL}:batchGenerateContent`,
    `/gw/gemini/v1beta/models/${MODEL}`,
    `/gw/gemini/v1beta/models`,
    `/gw/gemini/v1beta/cachedContents`,
    `/gw/gemini/v1beta/files`,
    `/gw/gemini/upload/v1beta/files`,
    `/gw/gemini/v1beta/tunedModels/x:generateContent`,
    `/gw/gemini/v1alpha/models/${MODEL}:generateContent`,
    `/gw/gemini/v1beta/models/${MODEL}:generateContent?key=CLIENT_KEY`,
    `/gw/gemini/v1beta/models/${MODEL}:streamGenerateContent?alt=sse&key=CLIENT_KEY`,
    `/gw/gemini/v1beta/models/${MODEL}:streamGenerateContent?alt=json`,
    `/gw/gemini/v1beta/models/${MODEL}:streamGenerateContent?alt=sse&alt=sse`,
    `/gw/gemini/v1beta/models/${MODEL}:generateContent?token=session`,
    `/gw/gemini/v1beta/models/${MODEL}:generateContent/extra`,
    `/gw/gemini/v1beta/models/Gemini-2.5-Flash:generateContent`,
    `/gw/gemini/v1beta/models/a/b:generateContent`,
    `/gw/gemini/v1beta/models/..%2F..%2Ffiles:generateContent`,
    `/gw/gemini/v1beta/models/${"a".repeat(65)}:generateContent`,
  ]) {
    test(`rejects ${bad}`, () => assert.equal(parseGeminiRoute(bad), null));
  }
});

describe("geminiModelServed — only models with a verified price row", () => {
  test("gemini-2.5-flash is served", () => assert.equal(geminiModelServed(MODEL), true));
  for (const model of [
    "gemini-2.5-flash-lite",
    "gemini-2.5-pro",
    "gemini-2.5-flash-image",
    "gemini-2.5-flash-preview-tts",
    "gemini-2.5-flash-native-audio-preview",
    "gemini-3-pro-preview",
    "gemini-2.0-flash",
    "claude-sonnet-4-6", // priced, but not this face's upstream
    "glm-4.6",
    "text-embedding-004",
  ]) {
    test(`${model} is refused`, () => assert.equal(geminiModelServed(model), false));
  }
});

describe("validateGeminiRequest — anything it cannot price is refused", () => {
  const user = { role: "user", parts: [{ text: "hi" }] };

  test("accepts text, function calling, thinking config, inline images and PDFs", () => {
    assert.equal(validateGeminiRequest({ contents: [user] }), null);
    assert.equal(
      validateGeminiRequest({
        contents: [
          user,
          {
            role: "model",
            parts: [{ functionCall: { name: "f", args: {} }, thoughtSignature: "s" }],
          },
          { role: "user", parts: [{ functionResponse: { name: "f", response: { ok: true } } }] },
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: "image/png", data: "AAAA" } },
              { inline_data: { mime_type: "application/pdf", data: "AAAA" } },
            ],
          },
        ],
        systemInstruction: { parts: [{ text: "be brief" }] },
        tools: [{ functionDeclarations: [{ name: "f", description: "d" }] }],
        toolConfig: { functionCallingConfig: { mode: "VALIDATED" } },
        generationConfig: {
          maxOutputTokens: 1024,
          temperature: 0.2,
          thinkingConfig: { thinkingBudget: 512 },
          responseModalities: ["TEXT"],
          candidateCount: 1,
        },
        safetySettings: [],
      }),
      null,
    );
    assert.equal(
      validateGeminiRequest({
        contents: [user],
        system_instruction: { parts: [{ text: "x" }] },
        generation_config: { max_output_tokens: 10 },
        tools: [{ function_declarations: [] }],
      }),
      null,
    );
  });

  const refused: Array<[string, Record<string, unknown>, RegExp]> = [
    ["no contents", {}, /contents must be a non-empty array/],
    [
      "Google Search grounding",
      { contents: [user], tools: [{ googleSearch: {} }] },
      /googleSearch/,
    ],
    [
      "Google Search grounding (snake_case)",
      { contents: [user], tools: [{ google_search: {} }] },
      /google_search/,
    ],
    [
      "search retrieval",
      { contents: [user], tools: [{ googleSearchRetrieval: {} }] },
      /googleSearchRetrieval/,
    ],
    ["code execution", { contents: [user], tools: [{ codeExecution: {} }] }, /codeExecution/],
    ["URL context", { contents: [user], tools: [{ urlContext: {} }] }, /urlContext/],
    [
      "a paid tool smuggled next to function declarations",
      { contents: [user], tools: [{ functionDeclarations: [], googleSearch: {} }] },
      /googleSearch/,
    ],
    [
      "a cached-content reference",
      { contents: [user], cachedContent: "cachedContents/x" },
      /cachedContent/,
    ],
    ["a model override in the body", { contents: [user], model: "gemini-2.5-pro" }, /"model"/],
    [
      "a file URI",
      { contents: [{ role: "user", parts: [{ fileData: { fileUri: "https://x/y.mp4" } }] }] },
      /fileData/,
    ],
    [
      "a file URI (snake_case)",
      { contents: [{ role: "user", parts: [{ file_data: { file_uri: "gs://b/o" } }] }] },
      /file_data/,
    ],
    [
      "inline audio",
      {
        contents: [{ role: "user", parts: [{ inlineData: { mimeType: "audio/mp3", data: "A" } }] }],
      },
      /audio\/mp3/,
    ],
    [
      "inline video",
      {
        contents: [
          { role: "user", parts: [{ inline_data: { mime_type: "video/mp4", data: "A" } }] },
        ],
      },
      /video\/mp4/,
    ],
    [
      "inline data with no type",
      { contents: [{ role: "user", parts: [{ inlineData: { data: "A" } }] }] },
      /inline data of type/,
    ],
    [
      "audio hidden in the system instruction",
      {
        contents: [user],
        systemInstruction: { parts: [{ inlineData: { mimeType: "audio/wav", data: "A" } }] },
      },
      /audio\/wav/,
    ],
    [
      "executable code parts",
      { contents: [{ role: "model", parts: [{ executableCode: { code: "1" } }] }] },
      /executableCode/,
    ],
    [
      "image output",
      { contents: [user], generationConfig: { responseModalities: ["TEXT", "IMAGE"] } },
      /only TEXT response modality/,
    ],
    [
      "audio output",
      { contents: [user], generation_config: { response_modalities: ["AUDIO"] } },
      /only TEXT response modality/,
    ],
    ["speech config", { contents: [user], generationConfig: { speechConfig: {} } }, /speechConfig/],
    [
      "several candidates",
      { contents: [user], generationConfig: { candidateCount: 4 } },
      /candidateCount/,
    ],
    [
      "several candidates (snake_case)",
      { contents: [user], generation_config: { candidate_count: 2 } },
      /candidateCount/,
    ],
    [
      "a non-numeric output ceiling",
      { contents: [user], generationConfig: { maxOutputTokens: "lots" } },
      /maxOutputTokens/,
    ],
    [
      "tools that are not an array",
      { contents: [user], tools: { googleSearch: {} } },
      /tools must be an array/,
    ],
    [
      "parts that are not objects",
      { contents: [{ role: "user", parts: ["hi"] }] },
      /must be objects/,
    ],
  ];
  for (const [label, body, pattern] of refused) {
    test(`refuses ${label}`, () => assert.match(validateGeminiRequest(body) ?? "", pattern));
  }
});

describe("usageMetadata metering (v0.27.1 semantics)", () => {
  test("thinking tokens are output; cached prompt tokens are billed once, at the cache rate", () => {
    const usage = usageFromGeminiJson({
      usageMetadata: {
        promptTokenCount: 1000,
        cachedContentTokenCount: 400,
        candidatesTokenCount: 50,
        thoughtsTokenCount: 200,
        totalTokenCount: 1250,
      },
    });
    assert.deepEqual(usage, {
      inputTokens: 600,
      outputTokens: 250,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
    });
    // input + cacheRead == the prompt Google counted: nothing is charged twice.
    assert.equal(usage.inputTokens + usage.cacheReadTokens, 1000);
  });

  test("stream counters are cumulative: merged by maximum, never summed", () => {
    let counts = ZERO_GEMINI_USAGE;
    for (const meta of [
      { promptTokenCount: 1000, thoughtsTokenCount: 120 },
      { promptTokenCount: 1000, candidatesTokenCount: 20, thoughtsTokenCount: 200 },
      { promptTokenCount: 1000, candidatesTokenCount: 50, thoughtsTokenCount: 200 },
    ]) {
      counts = mergeGeminiUsage(counts, { usageMetadata: meta });
    }
    assert.deepEqual(geminiUsageToProvider(counts), {
      inputTokens: 1000,
      outputTokens: 250,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  test("a cached count that only appears in the last chunk is still split out", () => {
    let counts = mergeGeminiUsage(ZERO_GEMINI_USAGE, { usageMetadata: { promptTokenCount: 1000 } });
    counts = mergeGeminiUsage(counts, {
      usageMetadata: {
        promptTokenCount: 1000,
        cachedContentTokenCount: 400,
        candidatesTokenCount: 5,
      },
    });
    assert.deepEqual(geminiUsageToProvider(counts), {
      inputTokens: 600,
      outputTokens: 5,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
    });
  });

  test("a trailing chunk that omits a counter does not erase it", () => {
    let counts = mergeGeminiUsage(ZERO_GEMINI_USAGE, {
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 7, thoughtsTokenCount: 3 },
    });
    counts = mergeGeminiUsage(counts, { usageMetadata: { promptTokenCount: 10 } });
    counts = mergeGeminiUsage(counts, { candidates: [] }); // no usageMetadata at all
    assert.equal(geminiUsageToProvider(counts).outputTokens, 10);
  });

  test("tool-use prompt tokens are billed as input; snake_case is read too", () => {
    assert.deepEqual(
      usageFromGeminiJson({
        usage_metadata: {
          prompt_token_count: 100,
          cached_content_token_count: 30,
          candidates_token_count: 8,
          thoughts_token_count: 2,
          tool_use_prompt_token_count: 40,
        },
      }),
      { inputTokens: 110, outputTokens: 10, cacheReadTokens: 30, cacheWriteTokens: 0 },
    );
  });

  test("garbage counters are zero, never NaN or negative", () => {
    assert.deepEqual(
      usageFromGeminiJson({
        usageMetadata: {
          promptTokenCount: "many",
          candidatesTokenCount: null,
          cachedContentTokenCount: 9,
        },
      }),
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    );
    assert.deepEqual(usageFromGeminiJson(null), geminiUsageToProvider(ZERO_GEMINI_USAGE));
    assert.deepEqual(usageFromGeminiJson("text"), geminiUsageToProvider(ZERO_GEMINI_USAGE));
  });

  test("a non-SSE stream body (a JSON array of chunks) is metered once", () => {
    assert.deepEqual(
      usageFromGeminiJson([
        { usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 10 } },
        {
          usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 30, thoughtsTokenCount: 5 },
        },
      ]),
      { inputTokens: 500, outputTokens: 35, cacheReadTokens: 0, cacheWriteTokens: 0 },
    );
  });
});

describe("clampGeminiOutput — the output side is held to the admitted budget", () => {
  const outPerM = priceForModel(MODEL).outPerM; // 3_500_000 micro-USD per M

  test("a small budget sets a ceiling the client did not ask for", () => {
    const body: Record<string, unknown> = { contents: [] };
    const budget = 35_000; // buys 10_000 output tokens
    assert.equal(clampGeminiOutput(body, MODEL, budget), 10_000);
    assert.deepEqual(body.generationConfig, { maxOutputTokens: 10_000 });
    assert.ok((10_000 * outPerM) / 1_000_000 <= budget);
  });

  test("a client ceiling above the budget is lowered; one below it is kept", () => {
    const high: Record<string, unknown> = {
      generationConfig: { maxOutputTokens: 60_000, temperature: 1 },
    };
    clampGeminiOutput(high, MODEL, 35_000);
    assert.deepEqual(high.generationConfig, { maxOutputTokens: 10_000, temperature: 1 });

    const low: Record<string, unknown> = { generationConfig: { maxOutputTokens: 500 } };
    assert.equal(clampGeminiOutput(low, MODEL, 35_000), 500);
    assert.deepEqual(low.generationConfig, { maxOutputTokens: 500 });
  });

  test("the snake_case spelling is clamped in place, not duplicated", () => {
    const body: Record<string, unknown> = { generation_config: { max_output_tokens: 60_000 } };
    clampGeminiOutput(body, MODEL, 35_000);
    assert.deepEqual(body, { generation_config: { max_output_tokens: 10_000 } });
  });

  test("a budget beyond the model's own limit leaves the request untouched", () => {
    const body: Record<string, unknown> = { contents: [] };
    assert.equal(clampGeminiOutput(body, MODEL, 50_000_000), null);
    assert.deepEqual(body, { contents: [] });
  });

  test("an unreadable budget yields the smallest ceiling, not none", () => {
    for (const budget of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      const body: Record<string, unknown> = {};
      assert.equal(clampGeminiOutput(body, MODEL, budget), 1_000, String(budget));
    }
  });
});

describe("planUpstream — gemini", () => {
  test("swaps in the operator key and targets Google's API", () => {
    const plan = planUpstream(
      "gemini",
      `/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`,
      MODEL,
      { authorization: "Bearer session", "x-goog-api-key": "client-key" },
      ENV,
    );
    assert.deepEqual(plan, {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`,
      headers: { "content-type": "application/json", "x-goog-api-key": OPERATOR_KEY },
    });
  });
  test("GOOGLE_API_KEY is the fallback; no key means not available", () => {
    assert.equal(
      planUpstream("gemini", "/x", MODEL, {}, { GOOGLE_API_KEY: "g" })?.headers["x-goog-api-key"],
      "g",
    );
    assert.equal(planUpstream("gemini", "/x", MODEL, {}, {}), null);
  });
});

// ── end to end over a socket ────────────────────────────────────────────────

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A stream body that arrives in the given pieces (to cut lines and code points apart). */
function chunked(pieces: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < pieces.length) controller.enqueue(pieces[i++]);
      else controller.close();
    },
  });
}

function fakeUpstream(respond: (captured: Captured) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  return {
    calls,
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const captured: Captured = {
        url: String(input),
        headers: { ...(init?.headers as Record<string, string>) },
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      calls.push(captured);
      return await respond(captured);
    },
  };
}

interface Admission {
  deps: AdmissionDependencies;
  log: string[];
  settled: Array<{ source: string; model: string; usage: ProviderUsage; reservationId: string }>;
}

function admission(overrides: Partial<AdmissionDependencies> = {}): Admission {
  const log: string[] = [];
  const settled: Admission["settled"] = [];
  return {
    log,
    settled,
    deps: {
      preflight: () => ({ ok: true }),
      acquire: async () => {
        log.push("acquire");
        return "off";
      },
      precheck: async (_acct, model) => {
        log.push(`precheck:${model}`);
        return { ok: true, budgetMicroUSD: 5_000_000 };
      },
      startRenewal: () => () => {},
      releaseLease: async () => {
        log.push("release");
      },
      settle: async (_acct, source, model, usage, reservationId) => {
        log.push("settle");
        settled.push({ source, model, usage, reservationId });
        return {
          at: new Date(0).toISOString(),
          source,
          model,
          ...usage,
          microUSD: costMicroUSD(model, usage),
          pricesVersion: 2,
        };
      },
      ...overrides,
    },
  };
}

/** Serve handleGateway on a real socket; `errors` collects what it throws (server.ts maps those to 503). */
async function gateway(
  deps: GatewayDependencies,
): Promise<{ base: string; errors: unknown[]; close: () => Promise<void> }> {
  const errors: unknown[] = [];
  const server = http.createServer((req, res) => {
    handleGateway(req, res, req.url ?? "", ACCT, deps).catch((err: unknown) => {
      errors.push(err);
      if (!res.headersSent) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "billing_state_unavailable" }));
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    errors,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function setup(
  respond: (captured: Captured) => Response | Promise<Response>,
  adm: Admission = admission(),
) {
  const upstream = fakeUpstream(respond);
  const deps: GatewayDependencies = {
    fetch: upstream.fetch,
    admit: (acct, model) => admitInference(acct, model, adm.deps),
    env: ENV,
  };
  return { upstream, adm, deps };
}

const post = (
  base: string,
  pathname: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  fetch(`${base}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer client-session",
      ...headers,
    },
    body: JSON.stringify(body),
  });

const REQUEST = { contents: [{ role: "user", parts: [{ text: "Summarise this." }] }] };
const GENERATE = `/gw/gemini/v1beta/models/${MODEL}:generateContent`;
const STREAM = `/gw/gemini/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`;

/**
 * A streamGenerateContent?alt=sse response in the documented wire shape: a
 * thinking phase, then text, with `usageMetadata` restated cumulatively on
 * every chunk and the cached-prompt count present throughout. (Written from
 * the API reference — there is no provider key in this environment to record
 * a live one.)
 */
const SSE_FIXTURE = [
  {
    candidates: [
      { content: { role: "model", parts: [{ text: "…thinking…", thought: true }] }, index: 0 },
    ],
    usageMetadata: {
      promptTokenCount: 4096,
      cachedContentTokenCount: 3072,
      thoughtsTokenCount: 310,
      totalTokenCount: 4406,
    },
    modelVersion: MODEL,
  },
  {
    candidates: [{ content: { role: "model", parts: [{ text: "这是摘要：" }] }, index: 0 }],
    usageMetadata: {
      promptTokenCount: 4096,
      cachedContentTokenCount: 3072,
      candidatesTokenCount: 6,
      thoughtsTokenCount: 512,
      totalTokenCount: 4614,
    },
    modelVersion: MODEL,
  },
  {
    candidates: [
      {
        content: { role: "model", parts: [{ text: " three points." }] },
        finishReason: "STOP",
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: 4096,
      cachedContentTokenCount: 3072,
      candidatesTokenCount: 41,
      thoughtsTokenCount: 512,
      totalTokenCount: 4649,
      promptTokensDetails: [{ modality: "TEXT", tokenCount: 4096 }],
    },
    modelVersion: MODEL,
    responseId: "resp_1",
  },
]
  .map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`)
  .join("");

const FIXTURE_USAGE: ProviderUsage = {
  inputTokens: 1024, // 4096 prompt − 3072 cached
  outputTokens: 553, // 41 candidates + 512 thinking
  cacheReadTokens: 3072,
  cacheWriteTokens: 0,
};

function sseResponse(text: string, cuts: number[]): Response {
  const bytes = new TextEncoder().encode(text);
  const pieces: Uint8Array[] = [];
  let start = 0;
  for (const cut of [...cuts, bytes.length]) {
    pieces.push(bytes.subarray(start, cut));
    start = cut;
  }
  return new Response(chunked(pieces), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("POST /gw/gemini — streaming", () => {
  test("passes the stream through byte for byte and meters it from usageMetadata", async () => {
    // Cut mid-line, mid-JSON and inside the multi-byte "…" / CJK characters.
    const { upstream, adm, deps } = setup(() =>
      sseResponse(SSE_FIXTURE, [7, 61, 62, 300, 301, 555]),
    );
    const gw = await gateway(deps);
    try {
      const res = await post(gw.base, STREAM, REQUEST);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
      assert.equal(await res.text(), SSE_FIXTURE);

      assert.equal(adm.settled.length, 1, "settled exactly once");
      assert.deepEqual(adm.settled[0]!.usage, FIXTURE_USAGE);
      assert.equal(adm.settled[0]!.model, MODEL);
      assert.equal(adm.settled[0]!.source, "gw");
      // 1024 × 0.42 + 553 × 3.5 + 3072 × 0.042 = 430.08 + 1935.5 + 129.02 → 2495
      assert.equal(costMicroUSD(MODEL, adm.settled[0]!.usage), 2_495);
      assert.deepEqual(adm.log, ["acquire", `precheck:${MODEL}`, "settle", "release"]);
      assert.equal(upstream.calls.length, 1);
      assert.deepEqual(gw.errors, []);
    } finally {
      await gw.close();
    }
  });

  test("the result does not depend on where the network cut the stream", async () => {
    const bytes = new TextEncoder().encode(SSE_FIXTURE).length;
    for (const cuts of [[], [1], [bytes - 1], Array.from({ length: 40 }, (_, i) => (i + 1) * 17)]) {
      const { adm, deps } = setup(() =>
        sseResponse(
          SSE_FIXTURE,
          cuts.filter((c) => c < bytes),
        ),
      );
      const gw = await gateway(deps);
      try {
        const res = await post(gw.base, STREAM, REQUEST);
        assert.equal(await res.text(), SSE_FIXTURE);
        assert.deepEqual(adm.settled[0]!.usage, FIXTURE_USAGE, `cuts ${cuts.length}`);
      } finally {
        await gw.close();
      }
    }
  });

  test("the operator key replaces every client credential", async () => {
    const { upstream, deps } = setup(() => sseResponse(SSE_FIXTURE, []));
    const gw = await gateway(deps);
    try {
      await (
        await post(gw.base, STREAM, REQUEST, {
          "x-goog-api-key": "client-supplied-key",
          cookie: "lisa_token=client-session",
        })
      ).text();
      const call = upstream.calls[0]!;
      assert.equal(
        call.url,
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`,
      );
      assert.deepEqual(call.headers, {
        "content-type": "application/json",
        "x-goog-api-key": OPERATOR_KEY,
      });
      const sent = JSON.stringify(call);
      for (const secret of ["client-session", "client-supplied-key"]) {
        assert.equal(sent.includes(secret), false, `${secret} reached the upstream`);
      }
    } finally {
      await gw.close();
    }
  });

  test("a final event with no trailing newline is still metered", async () => {
    // The last event carries the totals; a stream that ends right after its
    // closing brace must not fall back to the earlier, smaller counters.
    const unterminated = SSE_FIXTURE.replace(/\r\n\r\n$/, "");
    assert.notEqual(unterminated, SSE_FIXTURE);
    const { adm, deps } = setup(() => sseResponse(unterminated, [90]));
    const gw = await gateway(deps);
    try {
      assert.equal(await (await post(gw.base, STREAM, REQUEST)).text(), unterminated);
      assert.deepEqual(adm.settled[0]!.usage, FIXTURE_USAGE);
    } finally {
      await gw.close();
    }
  });

  test("a stream with no usageMetadata at all is billed by the byte floor, never free", async () => {
    const body = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] } }] })}\r\n\r\n`;
    const { adm, deps } = setup(() => sseResponse(body, []));
    const gw = await gateway(deps);
    try {
      await (await post(gw.base, STREAM, REQUEST)).text();
      const usage = adm.settled[0]!.usage;
      assert.ok(usage.inputTokens > 0 && usage.outputTokens > 0);
      assert.ok(costMicroUSD(MODEL, usage) > 0);
    } finally {
      await gw.close();
    }
  });

  test("a stream the upstream cuts short is billed for what was reported", async () => {
    const first = SSE_FIXTURE.slice(0, SSE_FIXTURE.indexOf("\r\n\r\n") + 4);
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(first));
      },
      pull(controller) {
        controller.error(new Error("upstream reset"));
      },
    });
    const { adm, deps } = setup(
      () => new Response(broken, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const gw = await gateway(deps);
    try {
      await (await post(gw.base, STREAM, REQUEST)).text().catch(() => "");
      assert.equal(adm.settled.length, 1);
      assert.deepEqual(adm.settled[0]!.usage, {
        inputTokens: 1024,
        outputTokens: 310,
        cacheReadTokens: 3072,
        cacheWriteTokens: 0,
      });
      assert.deepEqual(adm.log.slice(-2), ["settle", "release"]);
    } finally {
      await gw.close();
    }
  });
});

describe("POST /gw/gemini — non-streaming", () => {
  const RESPONSE = {
    candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    usageMetadata: {
      promptTokenCount: 200,
      cachedContentTokenCount: 0,
      candidatesTokenCount: 12,
      thoughtsTokenCount: 88,
      totalTokenCount: 300,
    },
  };
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  test("generateContent is forwarded and metered", async () => {
    const { upstream, adm, deps } = setup(() => json(RESPONSE));
    const gw = await gateway(deps);
    try {
      const res = await post(gw.base, GENERATE, REQUEST);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), RESPONSE);
      assert.deepEqual(adm.settled[0]!.usage, {
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      assert.equal(
        upstream.calls[0]!.url,
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      );
      assert.deepEqual(upstream.calls[0]!.body, REQUEST);
    } finally {
      await gw.close();
    }
  });

  test("streamGenerateContent without alt=sse (a JSON array) is metered once", async () => {
    const { adm, deps } = setup(() =>
      json([
        { usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 4 } },
        {
          usageMetadata: {
            promptTokenCount: 200,
            candidatesTokenCount: 12,
            thoughtsTokenCount: 88,
          },
        },
      ]),
    );
    const gw = await gateway(deps);
    try {
      await (
        await post(gw.base, `/gw/gemini/v1beta/models/${MODEL}:streamGenerateContent`, REQUEST)
      ).text();
      assert.deepEqual(adm.settled[0]!.usage, {
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    } finally {
      await gw.close();
    }
  });

  for (const status of [400, 429, 500]) {
    test(`an upstream ${status} is forwarded, not billed, and the permit is released`, async () => {
      const { adm, deps } = setup(() => json({ error: { code: status, message: "nope" } }, status));
      const gw = await gateway(deps);
      try {
        const res = await post(gw.base, GENERATE, REQUEST);
        assert.equal(res.status, status);
        assert.deepEqual(await res.json(), { error: { code: status, message: "nope" } });
        assert.deepEqual(adm.settled, []);
        assert.deepEqual(adm.log, ["acquire", `precheck:${MODEL}`, "release"]);
      } finally {
        await gw.close();
      }
    });
  }

  test("an unreachable upstream is a 502, unbilled, permit released", async () => {
    const { adm, deps } = setup(() => {
      throw new Error("ECONNRESET");
    });
    const gw = await gateway(deps);
    try {
      const res = await post(gw.base, GENERATE, REQUEST);
      assert.equal(res.status, 502);
      assert.deepEqual(adm.settled, []);
      assert.equal(adm.log.at(-1), "release");
    } finally {
      await gw.close();
    }
  });

  test("the output ceiling is clamped to the admitted budget before the upstream call", async () => {
    const adm = admission({
      precheck: async () => ({ ok: true, budgetMicroUSD: 35_000 }), // buys 10k output tokens
    });
    const { upstream, deps } = setup(() => json(RESPONSE), adm);
    const gw = await gateway(deps);
    try {
      await (
        await post(gw.base, GENERATE, { ...REQUEST, generationConfig: { maxOutputTokens: 65_536 } })
      ).text();
      await (await post(gw.base, GENERATE, REQUEST)).text();
      assert.deepEqual(upstream.calls[0]!.body.generationConfig, { maxOutputTokens: 10_000 });
      assert.deepEqual(upstream.calls[1]!.body.generationConfig, { maxOutputTokens: 10_000 });
    } finally {
      await gw.close();
    }
  });
});

describe("POST /gw/gemini — admission", () => {
  const never = (): Response => {
    throw new Error("the upstream must not be called");
  };

  test("no allowance left: 402, nothing sent upstream, lease released", async () => {
    const adm = admission({
      precheck: async () => ({
        ok: false,
        error: "quota_exhausted",
        resetAt: 1_800_000_000_000,
        tier: "free",
      }),
    });
    const { upstream, deps } = setup(never, adm);
    const gw = await gateway(deps);
    try {
      const res = await post(gw.base, STREAM, REQUEST);
      assert.equal(res.status, 402);
      assert.deepEqual(await res.json(), {
        error: "quota_exhausted",
        resetAt: 1_800_000_000_000,
        tier: "free",
      });
      assert.equal(upstream.calls.length, 0);
      assert.deepEqual(adm.settled, []);
      // The lease taken for the quota check is given back.
      assert.deepEqual(adm.log, ["acquire", "release"]);
    } finally {
      await gw.close();
    }
  });

  test("the service-wide limits refuse before any lease or quota work", async () => {
    const adm = admission({
      preflight: () => ({ ok: false, status: 402, body: { error: "service_paused" } }),
    });
    const { upstream, deps } = setup(never, adm);
    const gw = await gateway(deps);
    try {
      const res = await post(gw.base, GENERATE, REQUEST);
      assert.equal(res.status, 402);
      assert.deepEqual(await res.json(), { error: "service_paused" });
      assert.deepEqual(adm.log, []);
      assert.equal(upstream.calls.length, 0);
    } finally {
      await gw.close();
    }
  });

  test("a turn already in progress for the tenant is a 429", async () => {
    const adm = admission({ acquire: async () => null });
    const { upstream, deps } = setup(never, adm);
    const gw = await gateway(deps);
    try {
      const res = await post(gw.base, GENERATE, REQUEST);
      assert.equal(res.status, 429);
      assert.equal(((await res.json()) as { error: string }).error, "turn_in_progress");
      assert.equal(upstream.calls.length, 0);
    } finally {
      await gw.close();
    }
  });

  test("a quota store that cannot be read fails closed", async () => {
    const adm = admission({
      precheck: async () => {
        throw new BillingStateError("balance_unavailable", "balance.json is corrupt");
      },
    });
    const { upstream, deps } = setup(never, adm);
    const gw = await gateway(deps);
    try {
      const res = await post(gw.base, GENERATE, REQUEST);
      assert.equal(res.status, 503);
      assert.equal(upstream.calls.length, 0);
      assert.equal(gw.errors.length, 1);
      assert.ok(gw.errors[0] instanceof BillingStateError);
      assert.equal(adm.log.at(-1), "release");
    } finally {
      await gw.close();
    }
  });

  const refusedBeforeAdmission: Array<[string, string, unknown, number, string]> = [
    [
      "an unpriced model",
      `/gw/gemini/v1beta/models/gemini-2.5-pro:generateContent`,
      REQUEST,
      400,
      "model_not_supported",
    ],
    [
      "flash-lite",
      `/gw/gemini/v1beta/models/gemini-2.5-flash-lite:generateContent`,
      REQUEST,
      400,
      "model_not_supported",
    ],
    [
      "an image model",
      `/gw/gemini/v1beta/models/gemini-2.5-flash-image:generateContent`,
      REQUEST,
      400,
      "model_not_supported",
    ],
    [
      "search grounding",
      GENERATE,
      { ...REQUEST, tools: [{ googleSearch: {} }] },
      400,
      "unsupported_request",
    ],
    [
      "a cached-content reference",
      GENERATE,
      { ...REQUEST, cachedContent: "cachedContents/abc" },
      400,
      "unsupported_request",
    ],
    [
      "another method",
      `/gw/gemini/v1beta/models/${MODEL}:countTokens`,
      REQUEST,
      404,
      "unsupported_gemini_route",
    ],
    [
      "a client key in the query",
      `${GENERATE}?key=CLIENT`,
      REQUEST,
      404,
      "unsupported_gemini_route",
    ],
    ["a JSON array body", GENERATE, [REQUEST], 400, "bad_json"],
  ];
  for (const [label, pathname, body, status, error] of refusedBeforeAdmission) {
    test(`${label}: refused with ${status} before admission and before the upstream`, async () => {
      const adm = admission();
      const { upstream, deps } = setup(never, adm);
      const gw = await gateway(deps);
      try {
        const res = await post(gw.base, pathname, body);
        assert.equal(res.status, status);
        assert.equal(((await res.json()) as { error: string }).error, error);
        assert.deepEqual(adm.log, [], "no lease, no quota check");
        assert.equal(upstream.calls.length, 0);
      } finally {
        await gw.close();
      }
    });
  }

  test("no operator key for Gemini: 503 before admission", async () => {
    const adm = admission();
    const upstream = fakeUpstream(never);
    const gw = await gateway({
      fetch: upstream.fetch,
      admit: (acct, model) => admitInference(acct, model, adm.deps),
      env: {},
    });
    try {
      const res = await post(gw.base, GENERATE, REQUEST);
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { error: "model_not_available" });
      assert.deepEqual(adm.log, []);
    } finally {
      await gw.close();
    }
  });
});

describe("POST /gw/gemini — settlement failure and reconciliation", () => {
  const T0 = Date.parse("2026-10-02T08:00:00Z");
  const EXPECTED_COST = 2_495; // the fixture's usage at face value

  /** A ledger with the outbox's idempotency contract: an event id is applied at most once. */
  function ledger() {
    const applied = new Map<string, number>();
    let failures = 0;
    let attempts = 0;
    const debit: SettlementDeps["debit"] = async (_acct, event, eventId) => {
      attempts++;
      if (failures > 0) {
        failures--;
        throw new Error("EIO: balance store write failed");
      }
      const id = eventId ?? event.id;
      if (applied.has(id)) return false;
      applied.set(id, event.costMicros);
      return true;
    };
    return {
      debit,
      applied,
      failNext: (n: number) => (failures = n),
      attempts: () => attempts,
      total: () => [...applied.values()].reduce((a, b) => a + b, 0),
    };
  }

  /** Real admission, real settleUsage / commitUsageEvent, over an in-memory outbox and ledger. */
  function billing(store: InstanceType<typeof MemoryOutboxStore>, book: ReturnType<typeof ledger>) {
    const log: string[] = [];
    const settlement: SettlementDeps = {
      store,
      debit: book.debit,
      now: () => T0,
      enabled: () => true,
    };
    const deps: AdmissionDependencies = {
      preflight: () => ({ ok: true }),
      acquire: async () => "off",
      precheck: async () => ({ ok: true, budgetMicroUSD: 5_000_000 }),
      startRenewal: () => () => {},
      releaseLease: async () => {
        log.push("release");
      },
      settle: async (acct, source, model, usage, reservationId) => {
        const microUSD = costMicroUSD(model, usage);
        await settleUsage(
          { acct, kind: source, model, usage, costMicros: microUSD, reservationId },
          settlement,
        );
        return {
          at: new Date(T0).toISOString(),
          source,
          model,
          ...usage,
          microUSD,
          pricesVersion: 2,
        };
      },
    };
    return { deps, log, settlement };
  }

  const reconcileDeps = (
    store: InstanceType<typeof MemoryOutboxStore>,
    book: ReturnType<typeof ledger>,
  ) => ({
    store,
    debit: book.debit,
    loadAccount: async (uid: string) => (uid === ACCT.uid ? ACCT : null),
    now: () => T0 + 60_000,
  });

  async function openEvents(store: InstanceType<typeof MemoryOutboxStore>): Promise<UsageEvent[]> {
    return await store.listOpen(ACCT.uid);
  }

  test("happy path: one durable event, one debit, nothing left open", async () => {
    const store = new MemoryOutboxStore();
    const book = ledger();
    const bill = billing(store, book);
    const upstream = fakeUpstream(() => sseResponse(SSE_FIXTURE, [100]));
    const gw = await gateway({
      fetch: upstream.fetch,
      admit: (acct, model) => admitInference(acct, model, bill.deps),
      env: ENV,
    });
    try {
      assert.equal(await (await post(gw.base, STREAM, REQUEST)).text(), SSE_FIXTURE);
      assert.equal(book.total(), EXPECTED_COST);
      assert.equal(book.applied.size, 1);
      assert.deepEqual(await openEvents(store), []);
      assert.deepEqual(gw.errors, []);
    } finally {
      await gw.close();
    }
  });

  test("streaming: a failed debit parks the charge; reconciliation applies it exactly once", async () => {
    const store = new MemoryOutboxStore();
    const book = ledger();
    const bill = billing(store, book);
    book.failNext(1);
    const upstream = fakeUpstream(() => sseResponse(SSE_FIXTURE, [100]));
    const gw = await gateway({
      fetch: upstream.fetch,
      admit: (acct, model) => admitInference(acct, model, bill.deps),
      env: ENV,
    });
    try {
      // The stream had already been delivered when settlement ran.
      assert.equal(await (await post(gw.base, STREAM, REQUEST)).text(), SSE_FIXTURE);

      // The failure surfaced (server.ts logs it and answers 503 when it still can)…
      assert.equal(gw.errors.length, 1);
      assert.ok(gw.errors[0] instanceof BillingStateError);
      // …the permit was still released…
      assert.deepEqual(bill.log, ["release"]);
      // …nothing was debited, and the charge is NOT forgotten: it is parked.
      assert.equal(book.total(), 0);
      const parked = await openEvents(store);
      assert.equal(parked.length, 1);
      assert.equal(parked[0]!.status, "failed");
      assert.equal(parked[0]!.costMicros, EXPECTED_COST);
      assert.equal(parked[0]!.model, MODEL);
      assert.equal(parked[0]!.kind, "gw");
      assert.equal(parked[0]!.provider, "google");
      assert.equal(parked[0]!.tokensIn, 1024);
      assert.equal(parked[0]!.tokensOut, 553);
      assert.equal(parked[0]!.attempts, 1);
      assert.match(parked[0]!.lastError ?? "", /balance store write failed/);

      // Reconciliation retries the parked event and the money moves once.
      const first = await reconcileOnce({}, reconcileDeps(store, book));
      assert.equal(first.committed, 1);
      assert.equal(first.failed, 0);
      assert.equal(book.total(), EXPECTED_COST);
      assert.deepEqual(await openEvents(store), []);

      // A second pass — or a replay of the same event id — changes nothing.
      const second = await reconcileOnce({}, reconcileDeps(store, book));
      assert.equal(second.scanned, 0);
      assert.equal(await book.debit(ACCT, parked[0]!, parked[0]!.id), false);
      assert.equal(book.total(), EXPECTED_COST);
      assert.equal(book.applied.size, 1);
    } finally {
      await gw.close();
    }
  });

  test("non-streaming: a failed debit withholds the answer (503) and parks the charge", async () => {
    const store = new MemoryOutboxStore();
    const book = ledger();
    const bill = billing(store, book);
    book.failNext(1);
    const upstream = fakeUpstream(
      () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "the answer" }] } }],
            usageMetadata: {
              promptTokenCount: 4096,
              cachedContentTokenCount: 3072,
              candidatesTokenCount: 41,
              thoughtsTokenCount: 512,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const gw = await gateway({
      fetch: upstream.fetch,
      admit: (acct, model) => admitInference(acct, model, bill.deps),
      env: ENV,
    });
    try {
      const res = await post(gw.base, GENERATE, REQUEST);
      assert.equal(res.status, 503);
      assert.equal((await res.text()).includes("the answer"), false);
      assert.deepEqual(bill.log, ["release"]);
      const parked = await openEvents(store);
      assert.equal(parked.length, 1);
      assert.equal(parked[0]!.costMicros, EXPECTED_COST);
      assert.equal(book.total(), 0);

      await reconcileOnce({}, reconcileDeps(store, book));
      assert.equal(book.total(), EXPECTED_COST);
    } finally {
      await gw.close();
    }
  });

  test("a debit that keeps failing escalates to needs_human instead of looping or vanishing", async () => {
    const store = new MemoryOutboxStore();
    const book = ledger();
    const bill = billing(store, book);
    book.failNext(100);
    const upstream = fakeUpstream(() => sseResponse(SSE_FIXTURE, []));
    const gw = await gateway({
      fetch: upstream.fetch,
      admit: (acct, model) => admitInference(acct, model, bill.deps),
      env: ENV,
    });
    try {
      await (await post(gw.base, STREAM, REQUEST)).text();
      let escalated = 0;
      for (let pass = 0; pass < 10; pass++) {
        escalated += (await reconcileOnce({}, reconcileDeps(store, book))).escalated;
      }
      assert.equal(escalated, 1);
      const parked = await openEvents(store);
      assert.equal(parked.length, 1);
      assert.equal(parked[0]!.status, "needs_human");
      assert.equal(parked[0]!.costMicros, EXPECTED_COST);
      assert.equal(book.total(), 0);
      // Bounded: one live attempt + the reconciler's retry budget, then it stops.
      assert.equal(book.attempts(), 5);
    } finally {
      await gw.close();
    }
  });

  test("an outbox that cannot record the event refuses settlement — nothing is charged unrecorded", async () => {
    const store = new MemoryOutboxStore({
      faults: { append: () => new Error("firestore unavailable") },
    });
    const book = ledger();
    const bill = billing(store, book);
    const upstream = fakeUpstream(
      () =>
        new Response(
          JSON.stringify({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const gw = await gateway({
      fetch: upstream.fetch,
      admit: (acct, model) => admitInference(acct, model, bill.deps),
      env: ENV,
    });
    try {
      const res = await post(gw.base, GENERATE, REQUEST);
      assert.equal(res.status, 503);
      assert.ok(gw.errors[0] instanceof BillingStateError);
      assert.equal(book.attempts(), 0, "no debit without a durable record");
      assert.deepEqual(bill.log, ["release"]);
    } finally {
      await gw.close();
    }
  });
});

describe("POST /gw/gemini — driven by the real @google/genai client", () => {
  // The face has to accept what LISA's own Gemini provider actually sends, not
  // what this file assumes it sends: the SDK builds the path, the query and the
  // request body, and parses the stream that comes back through the gateway.
  const TOOL_STREAM = [
    {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "Checking. " }] },
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: 900,
        cachedContentTokenCount: 256,
        thoughtsTokenCount: 64,
      },
    },
    {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ functionCall: { name: "lookup", args: { q: "weather" } } }],
          },
          finishReason: "STOP",
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: 900,
        cachedContentTokenCount: 256,
        candidatesTokenCount: 18,
        thoughtsTokenCount: 64,
        totalTokenCount: 982,
      },
    },
  ]
    .map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`)
    .join("");

  test("GeminiProvider → gateway → upstream: accepted, parsed, and metered identically on both sides", async () => {
    const { GeminiProvider } = await import("../providers/gemini.js");
    const { upstream, adm, deps } = setup(() => sseResponse(TOOL_STREAM, [33, 200]));
    const gw = await gateway(deps);
    try {
      const provider = new GeminiProvider({
        apiKey: "client-session-token",
        baseURL: `${gw.base}/gw/gemini`,
      });
      const deltas: string[] = [];
      const result = await provider.runTurn({
        model: MODEL,
        systemPrompt: "You are terse.",
        tools: [
          {
            name: "lookup",
            description: "look something up",
            inputSchema: { type: "object", properties: { q: { type: "string" } } },
            execute: async () => "",
          },
        ],
        messages: [{ role: "user", content: "What's the weather?" }],
        maxTokens: 2_048,
        signal: new AbortController().signal,
        handlers: { onTextDelta: (text) => deltas.push(text) },
      });

      // The SDK's request reached the upstream through the validated route…
      assert.equal(upstream.calls.length, 1);
      const call = upstream.calls[0]!;
      assert.equal(
        call.url,
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`,
      );
      assert.equal(call.headers["x-goog-api-key"], OPERATOR_KEY);
      assert.equal(JSON.stringify(call).includes("client-session-token"), false);
      // …with its own body shape intact (system prompt, tools, validated calling, ceiling).
      assert.equal(validateGeminiRequest(call.body), null);
      assert.ok(Array.isArray(call.body.contents));
      assert.ok(call.body.systemInstruction);
      assert.ok(Array.isArray(call.body.tools));
      assert.equal(
        (call.body.generationConfig as { maxOutputTokens?: number }).maxOutputTokens,
        2_048,
      );

      // …and the SDK parsed the stream the gateway passed back.
      assert.deepEqual(deltas, ["Checking. "]);
      assert.equal(result.stopReason, "tool_use");
      const toolUse = result.content.find((b) => b.type === "tool_use");
      assert.ok(toolUse && toolUse.type === "tool_use");
      assert.equal(toolUse.name, "lookup");
      assert.deepEqual(toolUse.input, { q: "weather" });

      // The gateway billed exactly what the client-side provider counted.
      assert.equal(adm.settled.length, 1);
      assert.deepEqual(adm.settled[0]!.usage, result.usage);
      assert.deepEqual(result.usage, {
        inputTokens: 644, // 900 − 256
        outputTokens: 82, // 18 + 64 thinking
        cacheReadTokens: 256,
        cacheWriteTokens: 0,
      });
      assert.deepEqual(gw.errors, []);
    } finally {
      await gw.close();
    }
  });

  test("a signed-in client with no Gemini key reaches the face through the provider registry", async () => {
    const { providerForModel, hasCredentialsForModel, managedGeminiServed } =
      await import("../providers/registry.js");
    const SESSION = "s1.managed.session";
    const { upstream, adm, deps } = setup(() => sseResponse(TOOL_STREAM, []));
    // Stand in for server.ts's gate: the account session arrives as a Bearer
    // token (presentedToken), and only then is the gateway handler reached.
    const seenAuth: Array<string | undefined> = [];
    const server = http.createServer((req, res) => {
      seenAuth.push(req.headers.authorization);
      if (req.headers.authorization !== `Bearer ${SESSION}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      void handleGateway(req, res, req.url ?? "", ACCT, deps);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const keys = [
      "LISA_MANAGED_SESSION",
      "LISA_MANAGED_BASE",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "LISA_MODEL_FALLBACK",
      "LISA_BASE_URL",
      "LISA_PROVIDER",
    ] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    process.env.LISA_MANAGED_SESSION = SESSION;
    process.env.LISA_MANAGED_BASE = base;
    try {
      // The key gate: served Gemini models pass on a managed session; the rest do not.
      assert.equal(hasCredentialsForModel(MODEL), true);
      assert.equal(managedGeminiServed(MODEL), true);
      for (const unserved of ["gemini-2.5-pro", "gemini-2.5-flash-lite", "gemini-2.0-pro"]) {
        assert.equal(hasCredentialsForModel(unserved), false, unserved);
      }

      const result = await providerForModel(MODEL).runTurn({
        model: MODEL,
        systemPrompt: "sys",
        tools: [],
        messages: [{ role: "user", content: "hi" }],
        signal: new AbortController().signal,
      });
      assert.deepEqual(seenAuth, [`Bearer ${SESSION}`]);
      assert.equal(upstream.calls.length, 1);
      // The session never travels past the gateway.
      assert.equal(JSON.stringify(upstream.calls[0]).includes(SESSION), false);
      assert.equal(upstream.calls[0]!.headers["x-goog-api-key"], OPERATOR_KEY);
      assert.deepEqual(adm.settled[0]!.usage, result.usage);
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("a user's own Gemini key still wins over the managed session", async () => {
    const { hasOwnCredentialsForModel } = await import("../providers/registry.js");
    assert.equal(hasOwnCredentialsForModel(MODEL, { GEMINI_API_KEY: "mine" }), true);
    assert.equal(hasOwnCredentialsForModel(MODEL, { LISA_MANAGED_SESSION: "s" }), false);
  });

  test("a gateway refusal surfaces to the client as an error, not an empty answer", async () => {
    const { GeminiProvider } = await import("../providers/gemini.js");
    const adm = admission({
      precheck: async () => ({ ok: false, error: "quota_exhausted", resetAt: 1, tier: "free" }),
    });
    const { deps } = setup(() => {
      throw new Error("the upstream must not be called");
    }, adm);
    const gw = await gateway(deps);
    try {
      const provider = new GeminiProvider({ apiKey: "s", baseURL: `${gw.base}/gw/gemini` });
      await assert.rejects(
        () =>
          provider.runTurn({
            model: MODEL,
            systemPrompt: "sys",
            tools: [],
            messages: [{ role: "user", content: "hi" }],
            signal: new AbortController().signal,
          }),
        /quota_exhausted|402/,
      );
    } finally {
      await gw.close();
    }
  });
});
