import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { OpenAIProvider } from "./openai.js";
import { OPENAI_COMPAT_PRESETS } from "./registry.js";

describe("OPENAI_COMPAT_PRESETS — integration attribution header", () => {
  test("Perplexity preset sends X-Pplx-Integration", () => {
    const p = OPENAI_COMPAT_PRESETS.find((x) => x.name.startsWith("Perplexity"));
    assert.ok(p, "Perplexity preset missing");
    assert.equal(new URL(p.baseURL).hostname, "api.perplexity.ai");
    assert.deepEqual(p.defaultHeaders, { "X-Pplx-Integration": "lisa" });
  });

  test("no non-Perplexity preset sends X-Pplx-Integration", () => {
    for (const p of OPENAI_COMPAT_PRESETS) {
      if (new URL(p.baseURL).hostname === "api.perplexity.ai") continue;
      const keys = Object.keys(p.defaultHeaders ?? {}).map((k) => k.toLowerCase());
      assert.equal(
        keys.includes("x-pplx-integration"),
        false,
        `${p.name} sends X-Pplx-Integration`,
      );
    }
  });
});

describe("OpenAIProvider — defaultHeaders", () => {
  async function headersSent(opts: ConstructorParameters<typeof OpenAIProvider>[0]) {
    const realFetch = globalThis.fetch;
    let sent: Headers | undefined;
    globalThis.fetch = async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      sent = new Headers(init?.headers);
      const body =
        'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    try {
      await new OpenAIProvider(opts).runTurn({
        model: "sonar",
        systemPrompt: "sys",
        tools: [],
        messages: [{ role: "user", content: "hi" }],
      });
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.ok(sent, "fetch was not called");
    return sent;
  }

  test("sends configured default headers on chat requests", async () => {
    const sent = await headersSent({
      apiKey: "test-key",
      baseURL: "https://api.perplexity.ai",
      defaultHeaders: { "X-Pplx-Integration": "lisa" },
    });
    assert.equal(sent.get("x-pplx-integration"), "lisa");
  });

  test("sends no attribution header when none is configured", async () => {
    const sent = await headersSent({ apiKey: "test-key", baseURL: "https://api.example.com/v1" });
    assert.equal(sent.get("x-pplx-integration"), null);
  });
});
