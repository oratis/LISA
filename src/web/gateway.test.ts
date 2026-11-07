import { test, describe } from "node:test";
import assert from "node:assert/strict";

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AccountRecord } from "./accounts.js";

const {
  planUpstream,
  foldUsage,
  usageFromJson,
  estimateUsageFromBytes,
  gatewayUpstreamPath,
  clampOutputTokens,
  gatewayRequestRefusal,
  handleGateway,
} = await import("./gateway.js");
const { managedConfig, hasCredentialsForModel } = await import("../providers/registry.js");
const { costMicroUSD, priceForModel } = await import("../billing/prices.js");

const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe("planUpstream", () => {
  test("anthropic face swaps in the real key + version passthrough", () => {
    const plan = planUpstream(
      "anthropic",
      "/v1/messages",
      "claude-sonnet-4-6",
      { "anthropic-version": "2024-01-01" },
      { ANTHROPIC_API_KEY: "sk-real" },
    );
    assert.equal(plan?.url, "https://api.anthropic.com/v1/messages");
    assert.equal(plan?.headers["x-api-key"], "sk-real");
    assert.equal(plan?.headers["anthropic-version"], "2024-01-01");
  });

  test("openai face routes GLM through its preset with the ZHIPU key", () => {
    const plan = planUpstream(
      "openai",
      "/chat/completions",
      "glm-4.6",
      {},
      { ZHIPU_API_KEY: "zk" },
    );
    assert.ok(plan?.url.includes("bigmodel.cn"));
    assert.equal(plan?.headers.authorization, "Bearer zk");
  });

  test("openai face forwards a preset's default headers only to that preset", () => {
    const plan = planUpstream(
      "openai",
      "/chat/completions",
      "sonar-pro",
      {},
      {
        PERPLEXITY_API_KEY: "pk",
      },
    );
    assert.ok(plan?.url.startsWith("https://api.perplexity.ai/"));
    assert.equal(plan?.headers["X-Pplx-Integration"], "lisa");
    assert.equal(plan?.headers.authorization, "Bearer pk");
    const glm = planUpstream("openai", "/chat/completions", "glm-4.6", {}, { ZHIPU_API_KEY: "zk" });
    assert.equal(glm?.headers["X-Pplx-Integration"], undefined);
  });

  test("no operator key for the face → null (503 upstream)", () => {
    assert.equal(planUpstream("anthropic", "/v1/messages", "claude-3", {}, {}), null);
    assert.equal(planUpstream("openai", "/chat/completions", "glm-4.6", {}, {}), null);
  });
});

describe("usage tee-parsing", () => {
  test("anthropic stream: message_start and message_delta report cumulative totals", () => {
    let acc = foldUsage(
      "anthropic",
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 10,
            output_tokens: 1,
          },
        },
      },
      ZERO,
    );
    acc = foldUsage("anthropic", { type: "message_delta", usage: { output_tokens: 250 } }, acc);
    assert.deepEqual(acc, {
      inputTokens: 100,
      outputTokens: 250,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
    });
    acc = foldUsage("anthropic", { type: "message_delta", usage: { output_tokens: 250 } }, acc);
    assert.equal(acc.outputTokens, 250, "repeated cumulative snapshots never double-charge");
  });

  test("openai stream: only the final usage chunk counts; content chunks are neutral", () => {
    let acc = foldUsage("openai", { choices: [{ delta: { content: "hi" } }], usage: null }, ZERO);
    assert.deepEqual(acc, ZERO);
    acc = foldUsage("openai", { usage: { prompt_tokens: 42, completion_tokens: 88 } }, acc);
    assert.equal(acc.inputTokens, 42);
    assert.equal(acc.outputTokens, 88);
  });

  test("non-streaming JSON bodies for both faces", () => {
    assert.deepEqual(usageFromJson("anthropic", { usage: { input_tokens: 5, output_tokens: 7 } }), {
      inputTokens: 5,
      outputTokens: 7,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    assert.equal(
      usageFromJson("openai", { usage: { prompt_tokens: 3, completion_tokens: 4 } }).outputTokens,
      4,
    );
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
    const m = managedConfig({
      LISA_MANAGED_SESSION: "s1.x.y",
      LISA_MANAGED_BASE: "https://cloud.example.com/",
    });
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

describe("gateway route allowlist", () => {
  test("only the synchronous generation endpoint is forwarded", () => {
    assert.equal(gatewayUpstreamPath("anthropic", "/v1/messages"), "/v1/messages");
    assert.equal(
      gatewayUpstreamPath("anthropic", "/v1/messages?beta=true"),
      "/v1/messages?beta=true",
    );
    // The managed OpenAI client sends /v1/…; the provider base already has its version.
    assert.equal(gatewayUpstreamPath("openai", "/v1/chat/completions"), "/chat/completions");
    assert.equal(gatewayUpstreamPath("openai", "/chat/completions"), "/chat/completions");
    for (const path of [
      "/v1/messages/batches",
      "/v1/messages/count_tokens",
      "/v1/files",
      "/v1/messages?beta=false",
      "/v1/messages?other=1",
      "/v1/../v1/messages/batches",
    ]) {
      assert.equal(gatewayUpstreamPath("anthropic", path), null, path);
    }
    for (const path of [
      "/v1/batches",
      "/v1/embeddings",
      "/v1/images/generations",
      "/v1/responses",
      "/v1/chat/completions?x=1",
    ]) {
      assert.equal(gatewayUpstreamPath("openai", path), null, path);
    }
  });

  test("a vanilla OpenAI upstream URL has its version once", () => {
    const plan = planUpstream("openai", "/chat/completions", "gpt-4o", {}, { OPENAI_API_KEY: "k" });
    assert.equal(plan?.url, "https://api.openai.com/v1/chat/completions");
  });
});

describe("output clamp for the Anthropic and OpenAI faces", () => {
  const OPENAI = "https://api.openai.com/v1/chat/completions";
  const GLM = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

  test("a small budget lowers or sets the ceiling; a lower client ceiling is kept", () => {
    const outPerM = priceForModel("claude-sonnet-5-5").outPerM;
    const budget = Math.ceil((2_000 * outPerM) / 1_000_000); // buys 2_000 output tokens
    const big: Record<string, unknown> = { max_tokens: 64_000 };
    assert.equal(clampOutputTokens("anthropic", big, "claude-sonnet-5-5", budget, OPENAI), 2_000);
    assert.equal(big.max_tokens, 2_000);
    const small: Record<string, unknown> = { max_tokens: 500 };
    clampOutputTokens("anthropic", small, "claude-sonnet-5-5", budget, OPENAI);
    assert.equal(small.max_tokens, 500);
    const none: Record<string, unknown> = {};
    clampOutputTokens("anthropic", none, "claude-sonnet-5-5", budget, OPENAI);
    assert.equal(none.max_tokens, 2_000);
  });

  test("a manual thinking budget stays below the clamped ceiling", () => {
    const outPerM = priceForModel("claude-sonnet-5-5").outPerM;
    const body: Record<string, unknown> = {
      max_tokens: 32_000,
      thinking: { type: "enabled", budget_tokens: 16_000 },
    };
    clampOutputTokens(
      "anthropic",
      body,
      "claude-sonnet-5-5",
      Math.ceil((4_000 * outPerM) / 1e6),
      OPENAI,
    );
    assert.equal(body.max_tokens, 4_000);
    assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: 3_999 });
  });

  test("OpenAI picks the field its upstream accepts when the client sent none", () => {
    const outPerM = priceForModel("gpt-4o").outPerM;
    const budget = Math.ceil((3_000 * outPerM) / 1_000_000);
    const openai: Record<string, unknown> = {};
    clampOutputTokens("openai", openai, "gpt-4o", budget, OPENAI);
    assert.deepEqual(openai, { max_completion_tokens: 3_000 });
    const glm: Record<string, unknown> = {};
    clampOutputTokens(
      "openai",
      glm,
      "glm-4.6",
      Math.ceil((3_000 * priceForModel("glm-4.6").outPerM) / 1e6),
      GLM,
    );
    assert.deepEqual(glm, { max_tokens: 3_000 });
    const both: Record<string, unknown> = { max_tokens: 100_000, max_completion_tokens: 50 };
    assert.equal(clampOutputTokens("openai", both, "gpt-4o", budget, OPENAI), 50);
    assert.deepEqual(both, { max_tokens: 3_000, max_completion_tokens: 50 });
  });
});

describe("requests billed outside the token rates are refused (#447 review)", () => {
  const refused = (face: "anthropic" | "openai", model: string, body: Record<string, unknown>) =>
    gatewayRequestRefusal(face, model, body) !== null;

  test("Anthropic: server tools, MCP, containers, fallbacks and fast mode", () => {
    const m = "claude-haiku-5-5";
    for (const type of [
      "web_search_20260209",
      "web_fetch_20260209",
      "code_execution_20260521",
      "advisor_20260301",
      "mcp_toolset",
      "tool_search_tool_regex_20251119",
    ]) {
      assert.ok(refused("anthropic", m, { tools: [{ type, name: "x" }] }), type);
    }
    for (const field of ["mcp_servers", "container", "fallbacks"]) {
      assert.ok(refused("anthropic", m, { [field]: [] }), field);
    }
    assert.ok(refused("anthropic", m, { speed: "fast" }));
    // Custom and client-executed Anthropic tools bill as tokens and are served.
    assert.equal(
      gatewayRequestRefusal("anthropic", m, {
        tools: [
          { name: "lookup", input_schema: { type: "object" } },
          { type: "custom", name: "c", input_schema: { type: "object" } },
          { type: "bash_20250124", name: "bash" },
          { type: "text_editor_20250728", name: "str_replace_based_edit_tool" },
          { type: "computer_toolset_20260801", name: "computer" },
        ],
        speed: "standard",
      }),
      null,
    );
  });

  test("OpenAI-compatible: n, audio, search, priority tiers and built-in tools", () => {
    const m = "gpt-6-luna";
    assert.ok(refused("openai", m, { n: 8 }));
    assert.ok(refused("openai", m, { modalities: ["text", "audio"] }));
    assert.ok(refused("openai", m, { audio: { voice: "alloy", format: "wav" } }));
    assert.ok(refused("openai", m, { web_search_options: {} }));
    for (const tier of ["priority", "fast", "ultrafast", "scale"]) {
      assert.ok(refused("openai", m, { service_tier: tier }), tier);
    }
    assert.ok(refused("openai", "glm-4.6", { tools: [{ type: "web_search", web_search: {} }] }));
    assert.ok(
      refused("openai", m, {
        messages: [{ role: "user", content: [{ type: "input_audio", input_audio: {} }] }],
      }),
    );
    for (const model of [
      "gpt-4o-audio-preview",
      "gpt-4o-mini-search-preview",
      "gpt-5-search-api",
      "gpt-realtime",
      "gpt-audio",
      "gpt-4o-transcribe",
    ]) {
      assert.ok(refused("openai", model, {}), model);
    }
    assert.equal(
      gatewayRequestRefusal("openai", m, {
        n: 1,
        modalities: ["text"],
        service_tier: "flex",
        tools: [
          { type: "function", function: { name: "f" } },
          { type: "custom", custom: { name: "g" } },
        ],
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
      null,
    );
  });

  test("a refused request never reaches admission or the upstream", async () => {
    let admitted = 0;
    let forwarded = 0;
    const acct = { uid: "em-refuse" } as AccountRecord;
    const server = http.createServer((req, res) => {
      void handleGateway(req, res, req.url ?? "", acct, {
        env: { ANTHROPIC_API_KEY: "sk-test", OPENAI_API_KEY: "sk-test" },
        admit: async () => {
          admitted++;
          throw new Error("must not admit");
        },
        fetch: async () => {
          forwarded++;
          throw new Error("must not forward");
        },
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const anthropic = await fetch(`${base}/gw/anthropic/v1/messages`, {
        method: "POST",
        body: JSON.stringify({
          model: "claude-haiku-5-5",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
          tools: [{ type: "web_search_20260209", name: "web_search" }],
        }),
      });
      assert.equal(anthropic.status, 400);
      assert.equal(((await anthropic.json()) as { error: string }).error, "unsupported_request");
      const openai = await fetch(`${base}/gw/openai/v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ model: "gpt-6-luna", n: 16, messages: [] }),
      });
      assert.equal(openai.status, 400);
      assert.equal(admitted, 0);
      assert.equal(forwarded, 0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("managed mode does not route to a model the gateway refuses", () => {
    const env = { LISA_MANAGED_SESSION: "s1.x.y" };
    assert.equal(hasCredentialsForModel("gpt-4o-audio-preview", env), false);
    assert.equal(hasCredentialsForModel("gpt-6-luna", env), true);
  });
});

describe("usage folding for cache and server-side work (#447 review)", () => {
  test("Anthropic message_delta's cumulative prompt counts and the 1-hour writes are kept", () => {
    let acc = foldUsage(
      "anthropic",
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 30,
            cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
            output_tokens: 1,
          },
        },
      },
      ZERO,
    );
    acc = foldUsage(
      "anthropic",
      {
        type: "message_delta",
        usage: { input_tokens: 900, cache_read_input_tokens: 40, output_tokens: 250 },
      },
      acc,
    );
    assert.deepEqual(acc, {
      inputTokens: 900,
      outputTokens: 250,
      cacheReadTokens: 40,
      cacheWriteTokens: 30,
      cacheWrite1hTokens: 20,
    });
    assert.equal(
      usageFromJson("anthropic", {
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 5,
          cache_creation: { ephemeral_1h_input_tokens: 5 },
        },
      }).cacheWrite1hTokens,
      5,
    );
  });

  test("OpenAI cached prompt tokens are billed at the cache rate, not as input", () => {
    const usage = usageFromJson("openai", {
      usage: {
        prompt_tokens: 1_000,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 800 },
      },
    });
    assert.deepEqual(usage, {
      inputTokens: 200,
      outputTokens: 10,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
    });
    // A cached count above the prompt is held to it.
    assert.equal(
      usageFromJson("openai", {
        usage: {
          prompt_tokens: 5,
          completion_tokens: 1,
          prompt_tokens_details: { cached_tokens: 50 },
        },
      }).inputTokens,
      0,
    );
  });

  test("a ceiling too small for a manual thinking budget drops the budget", () => {
    const outPerM = priceForModel("claude-haiku-4-5").outPerM;
    const body: Record<string, unknown> = {
      max_tokens: 32_000,
      thinking: { type: "enabled", budget_tokens: 16_000 },
    };
    clampOutputTokens(
      "anthropic",
      body,
      "claude-haiku-4-5",
      Math.ceil((1_000 * outPerM) / 1e6),
      "https://api.anthropic.com/v1/messages",
    );
    assert.equal(body.max_tokens, 1_000);
    assert.equal(body.thinking, undefined);
  });
});
