import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { detectProvider, resolveAnthropicAuth, OPENAI_COMPAT_PRESETS } from "./registry.js";

// detectProvider reads a few env vars as fallbacks. Snapshot + restore them
// so tests are hermetic regardless of the dev's shell.
const ENV_KEYS = ["LISA_BASE_URL", "LISA_PROVIDER"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("detectProvider — native protocol prefixes", () => {
  test("claude-* → anthropic", () => {
    assert.equal(detectProvider("claude-sonnet-4-6"), "anthropic");
    assert.equal(detectProvider("claude-opus-4-8"), "anthropic");
  });

  test("gemini-* → gemini", () => {
    assert.equal(detectProvider("gemini-2.5-flash"), "gemini");
  });

  test("gpt-* / o1 / o3 / o4 / chatgpt-* → openai", () => {
    assert.equal(detectProvider("gpt-4o"), "openai");
    assert.equal(detectProvider("o1-preview"), "openai");
    assert.equal(detectProvider("o3-mini"), "openai");
    assert.equal(detectProvider("o4-mini"), "openai");
    assert.equal(detectProvider("chatgpt-4o-latest"), "openai");
  });

  test("unknown model with no env override → anthropic default", () => {
    assert.equal(detectProvider("some-unknown-model-xyz"), "anthropic");
  });
});

describe("detectProvider — case insensitivity", () => {
  test("native prefixes are case-insensitive", () => {
    assert.equal(detectProvider("Claude-Sonnet"), "anthropic");
    assert.equal(detectProvider("GEMINI-2.5-PRO"), "gemini");
    assert.equal(detectProvider("GPT-4O"), "openai");
  });

  test("preset prefixes are case-insensitive (the Baichuan/MiniMax bug)", () => {
    assert.equal(detectProvider("Baichuan4"), "openai");
    assert.equal(detectProvider("MiniMax-Text-01"), "openai");
    assert.equal(detectProvider("DeepSeek-Chat"), "openai");
  });
});

describe("detectProvider — third-party presets route through openai", () => {
  // Every preset's first prefix should resolve to the openai provider.
  for (const preset of OPENAI_COMPAT_PRESETS) {
    const prefix = preset.modelPrefixes[0]!;
    test(`${preset.name} (${prefix}…) → openai`, () => {
      assert.equal(detectProvider(prefix + "some-model"), "openai");
    });
  }
});

describe("detectProvider — env overrides", () => {
  test("LISA_BASE_URL forces openai for unknown models", () => {
    process.env.LISA_BASE_URL = "http://localhost:11434/v1";
    assert.equal(detectProvider("qwen2.5-32b-instruct"), "openai");
  });

  test("LISA_PROVIDER=gemini forces gemini for unknown models", () => {
    process.env.LISA_PROVIDER = "gemini";
    assert.equal(detectProvider("mystery-model"), "gemini");
  });

  test("explicit native prefix beats LISA_PROVIDER override", () => {
    // claude- prefix is checked before the LISA_PROVIDER fallback, so a
    // claude model still routes to anthropic even if the env says gemini.
    process.env.LISA_PROVIDER = "gemini";
    assert.equal(detectProvider("claude-sonnet-4-6"), "anthropic");
  });
});

describe("resolveAnthropicAuth — Bearer gateway vs x-api-key", () => {
  test("ANTHROPIC_AUTH_TOKEN → authToken (Bearer), no apiKey", () => {
    assert.deepEqual(resolveAnthropicAuth({ ANTHROPIC_AUTH_TOKEN: "tok" }), { authToken: "tok" });
  });
  test("only ANTHROPIC_API_KEY → apiKey (x-api-key)", () => {
    assert.deepEqual(resolveAnthropicAuth({ ANTHROPIC_API_KEY: "sk-ant" }), { apiKey: "sk-ant" });
  });
  test("AUTH_TOKEN wins when both are set (Claude Code precedence)", () => {
    assert.deepEqual(
      resolveAnthropicAuth({ ANTHROPIC_AUTH_TOKEN: "tok", ANTHROPIC_API_KEY: "sk-ant" }),
      { authToken: "tok" },
    );
  });
  test("blank/whitespace AUTH_TOKEN is ignored → falls back to apiKey", () => {
    assert.deepEqual(resolveAnthropicAuth({ ANTHROPIC_AUTH_TOKEN: "  ", ANTHROPIC_API_KEY: "sk" }), {
      apiKey: "sk",
    });
  });
  test("neither set → apiKey undefined", () => {
    assert.deepEqual(resolveAnthropicAuth({}), { apiKey: undefined });
  });
});

describe("OPENAI_COMPAT_PRESETS — table integrity", () => {
  test("every preset has name, baseURL, apiKeyEnv, and >=1 prefix", () => {
    for (const p of OPENAI_COMPAT_PRESETS) {
      assert.ok(p.name, "preset missing name");
      assert.match(p.baseURL, /^https?:\/\//, `${p.name} baseURL not a URL`);
      assert.match(p.apiKeyEnv, /^[A-Z0-9_]+$/, `${p.name} apiKeyEnv malformed`);
      assert.ok(p.modelPrefixes.length > 0, `${p.name} has no prefixes`);
    }
  });

  test("no two presets share a model prefix (ambiguous routing)", () => {
    const seen = new Map<string, string>();
    for (const p of OPENAI_COMPAT_PRESETS) {
      for (const pre of p.modelPrefixes) {
        const key = pre.toLowerCase();
        assert.equal(
          seen.has(key),
          false,
          `prefix "${pre}" claimed by both ${seen.get(key)} and ${p.name}`,
        );
        seen.set(key, p.name);
      }
    }
  });
});
