import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  configStatusPayload,
  parseConfigSave,
  providerConfigList,
  writableConfigKeys,
} from "./config-api.js";
import { OPENAI_COMPAT_PRESETS } from "../providers/registry.js";

const KEY = "sk-test-0123456789abcdefghij";

describe("provider config list (T-9)", () => {
  test("covers the three built-ins plus every registry preset, with no drift", () => {
    const list = providerConfigList({});
    const ids = list.map((p) => p.id);
    for (const id of ["anthropic", "openai", "gemini"]) assert.ok(ids.includes(id), id);
    // Derived, not restated: adding a preset to the registry must show up here.
    assert.equal(list.length, 3 + OPENAI_COMPAT_PRESETS.length);
    for (const preset of OPENAI_COMPAT_PRESETS) {
      const row = list.find((p) => p.envKey === preset.apiKeyEnv);
      assert.ok(row, preset.apiKeyEnv);
      assert.equal(row!.label, preset.name);
      assert.deepEqual(row!.modelPrefixes, preset.modelPrefixes);
    }
    assert.equal(list.find((p) => p.envKey === "ZHIPU_API_KEY")?.id, "zhipu");
  });

  test("configured reflects the environment, and the alternate credential names", () => {
    assert.equal(providerConfigList({}).every((p) => !p.configured), true);
    const withZhipu = providerConfigList({ ZHIPU_API_KEY: KEY });
    assert.equal(withZhipu.find((p) => p.id === "zhipu")!.configured, true);
    assert.equal(withZhipu.find((p) => p.id === "anthropic")!.configured, false);
    // Anthropic's OAuth token and Google's alternate name both count.
    assert.equal(
      providerConfigList({ ANTHROPIC_AUTH_TOKEN: KEY }).find((p) => p.id === "anthropic")!.configured,
      true,
    );
    assert.equal(
      providerConfigList({ GOOGLE_API_KEY: KEY }).find((p) => p.id === "gemini")!.configured,
      true,
    );
    // Whitespace is not a key.
    assert.equal(providerConfigList({ OPENAI_API_KEY: "  " }).find((p) => p.id === "openai")!.configured, false);
  });
});

describe("/api/config/status payload", () => {
  test("keeps the legacy fields and adds providers + model", () => {
    const p = configStatusPayload("claude-sonnet-4-6", { ANTHROPIC_API_KEY: KEY });
    assert.equal(p.configured, true);
    assert.equal(p.anthropic, true);
    assert.equal(p.openai, false);
    assert.equal(p.model, "claude-sonnet-4-6");
    assert.ok(Array.isArray(p.providers) && p.providers.length > 3);
  });

  test("a preset-only install now reads as configured (it used to say no)", () => {
    // The old status reported `configured: !!ANTHROPIC_API_KEY`, so a working
    // `--model glm-4` install re-showed the setup popup forever.
    const p = configStatusPayload("glm-4", { ZHIPU_API_KEY: KEY });
    assert.equal(p.configured, true);
    assert.equal(p.anthropic, false);
  });

  test("no key anywhere ⇒ not configured", () => {
    assert.equal(configStatusPayload("claude-sonnet-4-6", {}).configured, false);
  });

  test("the payload never contains a key value", () => {
    const json = JSON.stringify(configStatusPayload("m", { ANTHROPIC_API_KEY: KEY, ZHIPU_API_KEY: KEY }));
    assert.equal(json.includes(KEY), false);
  });
});

describe("/api/config/save body", () => {
  test("accepts whitelisted env keys", () => {
    const r = parseConfigSave({ keys: { ZHIPU_API_KEY: KEY, ANTHROPIC_API_KEY: KEY } });
    assert.deepEqual(r, { ok: true, updates: { ZHIPU_API_KEY: KEY, ANTHROPIC_API_KEY: KEY } });
  });

  test("model and baseUrl map onto LISA_MODEL / LISA_BASE_URL", () => {
    const r = parseConfigSave({ keys: { LISA_API_KEY: KEY }, model: "glm-4", baseUrl: "https://api.example.com/v1" });
    assert.ok(r.ok);
    assert.deepEqual(r.updates, {
      LISA_API_KEY: KEY,
      LISA_MODEL: "glm-4",
      LISA_BASE_URL: "https://api.example.com/v1",
    });
  });

  test("an env name outside the whitelist is a 400 — nothing is written", () => {
    for (const bad of ["PATH", "NODE_OPTIONS", "LISA_EDITION", "LISA_WEB_TOKEN", "ANTHROPIC_API_KEY_"]) {
      const r = parseConfigSave({ keys: { [bad]: KEY } });
      assert.equal(r.ok, false, bad);
      if (!r.ok) {
        assert.equal(r.status, 400);
        assert.match(r.error, /unknown config key/);
      }
    }
    // Every writable name is one this endpoint is meant to own.
    for (const k of writableConfigKeys()) {
      assert.ok(/_API_KEY$/.test(k) || k.startsWith("LISA_"), k);
    }
  });

  test("malformed values are rejected, and the error never echoes the value", () => {
    const short = parseConfigSave({ keys: { OPENAI_API_KEY: "tiny" } });
    assert.equal(short.ok, false);
    if (!short.ok) {
      assert.match(short.error, /malformed/);
      assert.equal(short.error.includes("tiny"), false);
    }
    assert.equal(parseConfigSave({ keys: { OPENAI_API_KEY: 42 } }).ok, false);
    assert.equal(parseConfigSave({ baseUrl: "file:///etc/passwd" }).ok, false);
    assert.equal(parseConfigSave({ baseUrl: "not a url" }).ok, false);
    assert.equal(parseConfigSave({ model: "a model with spaces" }).ok, false);
    assert.equal(parseConfigSave({ keys: [] }).ok, false);
    assert.equal(parseConfigSave(null).ok, false);
    assert.equal(parseConfigSave("nope").ok, false);
  });

  test("an empty body is a 400, not a silent no-op write", () => {
    const r = parseConfigSave({});
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /no keys provided/);
  });

  test("the legacy popup body still works, in both spellings", () => {
    assert.deepEqual(parseConfigSave({ anthropicKey: KEY, openaiKey: "" }), {
      ok: true,
      updates: { ANTHROPIC_API_KEY: KEY },
    });
    assert.deepEqual(parseConfigSave({ anthropic: KEY, openai: KEY }), {
      ok: true,
      updates: { ANTHROPIC_API_KEY: KEY, OPENAI_API_KEY: KEY },
    });
  });
});
