import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { explicitPriceForModel, priceForModel } from "../billing/prices.js";
import { OpenAIProvider } from "../providers/openai.js";
import {
  PURPOSE_TIER,
  autoSmallModel,
  billingSafeInCloud,
  modelFamily,
  providerForRoute,
  resolveRoute,
  routeBackgroundCall,
  routeModel,
  tierForPurpose,
  type ModelPurpose,
} from "./router.js";

const STRONG_PURPOSES: ModelPurpose[] = ["chat", "plan", "execute"];
const SMALL_PURPOSES: ModelPurpose[] = ["triage", "classify", "summarize", "watch"];

// hasCredentialsForModel consults process.env for the LISA_BASE_URL /
// LISA_PROVIDER routing rules; keep those out of the way so the tables below
// describe the router and not this machine's config.
const AMBIENT = ["LISA_BASE_URL", "LISA_PROVIDER", "LISA_EDITION", "OLLAMA_HOST"] as const;
const saved: Record<string, string | undefined> = {};
before(() => {
  for (const key of AMBIENT) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});
after(() => {
  for (const key of AMBIENT) {
    if (saved[key] !== undefined) process.env[key] = saved[key];
  }
});

describe("purpose tiers", () => {
  test("user-facing work stays on the strong tier; background work goes small", () => {
    assert.deepEqual(PURPOSE_TIER, {
      chat: "strong",
      plan: "strong",
      execute: "strong",
      triage: "small",
      classify: "small",
      summarize: "small",
      watch: "small",
    });
    assert.equal(tierForPurpose("chat"), "strong");
    assert.equal(tierForPurpose("classify"), "small");
  });
});

describe("modelFamily", () => {
  test("classifies by id alone", () => {
    assert.equal(modelFamily("claude-sonnet-4-6"), "anthropic");
    assert.equal(modelFamily("gemini-2.5-flash"), "gemini");
    for (const id of ["gpt-4o", "gpt-5", "o3", "o4-mini", "chatgpt-4o-latest"]) {
      assert.equal(modelFamily(id), "openai", id);
    }
    assert.equal(modelFamily("glm-4.6"), "preset");
    assert.equal(modelFamily("deepseek-chat"), "preset");
    assert.equal(modelFamily("qwen2.5:14b"), "preset");
    assert.equal(modelFamily("llama3.2"), "custom");
  });
});

describe("autoSmallModel — one small model per first-party family", () => {
  const table: Array<[string, string | null]> = [
    ["claude-sonnet-4-6", "claude-haiku-4-5"],
    ["claude-opus-4-8", "claude-haiku-4-5"],
    ["claude-haiku-4-5", null], // already small
    ["gemini-2.5-pro", "gemini-2.5-flash-lite"],
    ["gemini-2.5-flash", "gemini-2.5-flash-lite"],
    ["gemini-2.5-flash-lite", null],
    ["gpt-4o", "gpt-4o-mini"],
    ["gpt-5", "gpt-4o-mini"],
    ["o3", "gpt-4o-mini"],
    ["gpt-4o-mini", null],
    ["gpt-4.1-nano", null],
    ["o4-mini", null],
    ["glm-4.6", null], // preset family: no verified small id
    ["deepseek-chat", null],
    ["llama3.2", null],
  ];
  for (const [strong, expected] of table) {
    test(`${strong} → ${expected ?? "(stays)"}`, () => {
      assert.equal(autoSmallModel(strong), expected);
    });
  }

  test("every auto-picked id that the price table knows is cheaper than its family's strong models", () => {
    for (const [strong, small] of [
      ["claude-sonnet-4-6", "claude-haiku-4-5"],
      ["gpt-4o", "gpt-4o-mini"],
    ] as const) {
      const s = explicitPriceForModel(small);
      assert.ok(s, `${small} must have an explicit price row`);
      assert.ok(s.inPerM < priceForModel(strong).inPerM, small);
      assert.ok(s.outPerM < priceForModel(strong).outPerM, small);
    }
    // Deliberately unpriced since v0.27.1 — the reason cloud will not route to it.
    assert.equal(explicitPriceForModel("gemini-2.5-flash-lite"), null);
  });
});

describe("resolveRoute — strong purposes are never rerouted", () => {
  for (const purpose of STRONG_PURPOSES) {
    test(`${purpose} uses the strong model whatever LISA_MODEL_SMALL says`, () => {
      const env = {
        ANTHROPIC_API_KEY: "k",
        OPENAI_API_KEY: "k",
        LISA_MODEL_SMALL: "gpt-4o-mini",
      };
      assert.deepEqual(resolveRoute(purpose, { model: "claude-sonnet-4-6", env }), {
        purpose,
        tier: "strong",
        model: "claude-sonnet-4-6",
        source: "strong",
      });
    });
  }

  test("the strong model is ctx.model, else LISA_MODEL, else the built-in default", () => {
    assert.equal(routeModel("chat", { model: "gpt-4o", env: { LISA_MODEL: "glm-4.6" } }), "gpt-4o");
    assert.equal(routeModel("chat", { env: { LISA_MODEL: " glm-4.6 " } }), "glm-4.6");
    assert.equal(routeModel("chat", { env: {} }), "claude-sonnet-4-6");
  });
});

describe("resolveRoute — small purposes, local edition", () => {
  const families: Array<[string, Record<string, string>, string]> = [
    ["claude-sonnet-4-6", { ANTHROPIC_API_KEY: "k" }, "claude-haiku-4-5"],
    ["claude-opus-4-8", { ANTHROPIC_AUTH_TOKEN: "t" }, "claude-haiku-4-5"],
    ["gemini-2.5-pro", { GEMINI_API_KEY: "k" }, "gemini-2.5-flash-lite"],
    ["gemini-2.5-flash", { GOOGLE_API_KEY: "k" }, "gemini-2.5-flash-lite"],
    ["gpt-4o", { OPENAI_API_KEY: "k" }, "gpt-4o-mini"],
  ];
  for (const [strong, env, small] of families) {
    for (const purpose of SMALL_PURPOSES) {
      test(`${purpose} on ${strong} → ${small}`, () => {
        const route = resolveRoute(purpose, { model: strong, env });
        assert.deepEqual(route, { purpose, tier: "small", model: small, source: "auto" });
      });
    }
  }

  test("an already-small or unknown-family strong model is kept", () => {
    for (const [strong, env] of [
      ["claude-haiku-4-5", { ANTHROPIC_API_KEY: "k" }],
      ["glm-4.6", { ZHIPU_API_KEY: "k" }],
      ["deepseek-chat", { DEEPSEEK_API_KEY: "k" }],
      ["llama3.2", {}],
    ] as const) {
      const route = resolveRoute("classify", { model: strong, env });
      assert.equal(route.model, strong);
      assert.equal(route.source, "strong-fallback");
      assert.match(route.reason ?? "", /no smaller model is known/);
    }
  });

  test("LISA_MODEL_SMALL overrides the auto-pick, across families", () => {
    const env = { ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k", LISA_MODEL_SMALL: "gpt-4o-mini" };
    assert.deepEqual(resolveRoute("summarize", { model: "claude-sonnet-4-6", env }), {
      purpose: "summarize",
      tier: "small",
      model: "gpt-4o-mini",
      source: "configured",
    });
  });

  test("a local user's explicit small model is honoured even when the price table does not know it", () => {
    const env = { ANTHROPIC_API_KEY: "k", DEEPSEEK_API_KEY: "k", LISA_MODEL_SMALL: "deepseek-chat" };
    assert.equal(routeModel("triage", { model: "claude-sonnet-4-6", env }), "deepseek-chat");
  });

  test("a small model without credentials is skipped, not attempted", () => {
    const configured = resolveRoute("classify", {
      model: "claude-sonnet-4-6",
      env: { ANTHROPIC_API_KEY: "k", LISA_MODEL_SMALL: "gpt-4o-mini" },
    });
    assert.equal(configured.model, "claude-sonnet-4-6");
    assert.equal(configured.source, "strong-fallback");
    assert.match(configured.reason ?? "", /no credentials for LISA_MODEL_SMALL=gpt-4o-mini/);

    // Same for the auto-pick: an OpenAI-shaped id reached through some other
    // credential has no key for gpt-4o-mini.
    const auto = resolveRoute("classify", { model: "gpt-4o", env: {} });
    assert.equal(auto.model, "gpt-4o");
    assert.match(auto.reason ?? "", /no credentials for gpt-4o-mini/);
  });

  test("local://[backend/]model routes to that runtime's endpoint", () => {
    const route = resolveRoute("classify", {
      model: "claude-sonnet-4-6",
      env: { ANTHROPIC_API_KEY: "k", LISA_MODEL_SMALL: "local://ollama/qwen2.5:3b" },
    });
    assert.equal(route.model, "qwen2.5:3b");
    assert.equal(route.source, "configured");
    assert.equal(route.local?.backend, "ollama");
    assert.equal(route.local?.baseURL, "http://localhost:11434/v1");
    assert.ok(providerForRoute(route) instanceof OpenAIProvider);

    const bare = resolveRoute("watch", { env: { LISA_MODEL_SMALL: "local://llama3.2" } });
    assert.equal(bare.model, "llama3.2");
    assert.equal(bare.local?.backend, "ollama");

    const lm = resolveRoute("watch", { env: { LISA_MODEL_SMALL: "local://lmstudio/phi-4" } });
    assert.equal(lm.local?.baseURL, "http://localhost:1234/v1");
  });

  test("a malformed local reference keeps the strong model", () => {
    const route = resolveRoute("classify", {
      model: "claude-sonnet-4-6",
      env: { LISA_MODEL_SMALL: "local://" },
    });
    assert.equal(route.model, "claude-sonnet-4-6");
    assert.match(route.reason ?? "", /not a valid local:\/\/ reference/);
  });
});

describe("resolveRoute — hosted edition never routes to a costlier or unpriced model", () => {
  const cloud = { LISA_EDITION: "cloud" };

  test("production (gemini-2.5-flash) keeps background work on Flash", () => {
    // gemini-2.5-flash-lite has no price row: routed there, a background call
    // would be billed at the premium fallback and refused the free allowance.
    for (const purpose of SMALL_PURPOSES) {
      const route = resolveRoute(purpose, {
        model: "gemini-2.5-flash",
        env: { ...cloud, GEMINI_API_KEY: "k" },
      });
      assert.equal(route.model, "gemini-2.5-flash", purpose);
      assert.equal(route.source, "strong-fallback");
      assert.match(route.reason ?? "", /gemini-2\.5-flash-lite is not priced at or below/);
    }
  });

  test("an operator's LISA_MODEL_SMALL is refused when it would bill more", () => {
    for (const small of ["gemini-2.5-flash-lite", "claude-haiku-4-5", "gpt-4o-mini", "gpt-4o"]) {
      const route = resolveRoute("classify", {
        model: "gemini-2.5-flash",
        env: {
          ...cloud,
          GEMINI_API_KEY: "k",
          ANTHROPIC_API_KEY: "k",
          OPENAI_API_KEY: "k",
          LISA_MODEL_SMALL: small,
        },
      });
      assert.equal(route.model, "gemini-2.5-flash", small);
      assert.equal(route.source, "strong-fallback", small);
    }
  });

  test("a priced, cheaper, same-tier small model is used", () => {
    const env = { ...cloud, ANTHROPIC_API_KEY: "k" };
    assert.deepEqual(resolveRoute("classify", { model: "claude-sonnet-4-6", env }), {
      purpose: "classify",
      tier: "small",
      model: "claude-haiku-4-5",
      source: "auto",
    });
  });

  test("local runtimes are not reachable from the hosted edition", () => {
    const route = resolveRoute("classify", {
      model: "gemini-2.5-flash",
      env: { ...cloud, GEMINI_API_KEY: "k", LISA_MODEL_SMALL: "local://ollama/llama3.2" },
    });
    assert.equal(route.model, "gemini-2.5-flash");
    assert.equal(route.local, undefined);
    assert.match(route.reason ?? "", /not available in the hosted edition/);
  });

  test("billingSafeInCloud", () => {
    assert.equal(billingSafeInCloud("claude-haiku-4-5", "claude-sonnet-4-6"), true);
    assert.equal(billingSafeInCloud("gpt-4o-mini", "gpt-4o"), true);
    // standard → premium is refused even when the per-token rate is lower.
    assert.equal(billingSafeInCloud("gpt-4o-mini", "gemini-2.5-flash"), false);
    // unpriced ids are refused.
    assert.equal(billingSafeInCloud("gemini-2.5-flash-lite", "gemini-2.5-pro"), false);
    assert.equal(billingSafeInCloud("some-new-model", "claude-opus-4-8"), false);
    // costlier is refused.
    assert.equal(billingSafeInCloud("claude-opus-4-8", "claude-sonnet-4-6"), false);
    // the same model is trivially safe.
    assert.equal(billingSafeInCloud("gemini-2.5-flash", "gemini-2.5-flash"), true);
  });
});

describe("routeBackgroundCall — what a background call site passes to the model", () => {
  const pinned = {
    name: "pinned",
    runTurn: async () => {
      throw new Error("unused");
    },
  };

  test("a caller-pinned provider is never rerouted", () => {
    const call = routeBackgroundCall("classify", {
      model: "claude-sonnet-4-6",
      provider: pinned,
      env: { ANTHROPIC_API_KEY: "k", LISA_MODEL_SMALL: "gpt-4o-mini", OPENAI_API_KEY: "k" },
    });
    assert.equal(call.model, "claude-sonnet-4-6");
    assert.equal(call.provider, pinned);
    assert.equal(call.route, null);
    // With no model either, the previous default is kept.
    assert.equal(routeBackgroundCall("classify", { provider: pinned }).model, "claude-sonnet-4-6");
  });

  test("a hosted-API route returns only the model id; the call site resolves the provider", () => {
    const call = routeBackgroundCall("classify", {
      model: "claude-sonnet-4-6",
      env: { ANTHROPIC_API_KEY: "k" },
    });
    assert.equal(call.model, "claude-haiku-4-5");
    assert.equal(call.provider, undefined);
    assert.equal(call.route?.source, "auto");
  });

  test("with no model passed, LISA_MODEL is the strong model", () => {
    const call = routeBackgroundCall("classify", {
      env: { LISA_MODEL: "gpt-4o", OPENAI_API_KEY: "k" },
    });
    assert.equal(call.model, "gpt-4o-mini");
    const stays = routeBackgroundCall("classify", {
      env: { LISA_MODEL: "glm-4.6", ZHIPU_API_KEY: "k" },
    });
    assert.equal(stays.model, "glm-4.6");
  });

  test("a local route carries the local runtime's provider", () => {
    const call = routeBackgroundCall("classify", {
      model: "claude-sonnet-4-6",
      env: { LISA_MODEL_SMALL: "local://ollama/llama3.2" },
    });
    assert.equal(call.model, "llama3.2");
    assert.ok(call.provider instanceof OpenAIProvider);
  });

  test("the hosted production configuration is unchanged", () => {
    const call = routeBackgroundCall("classify", {
      model: "gemini-2.5-flash",
      env: { LISA_EDITION: "cloud", GEMINI_API_KEY: "k" },
    });
    assert.equal(call.model, "gemini-2.5-flash");
    assert.equal(call.provider, undefined);
  });
});
