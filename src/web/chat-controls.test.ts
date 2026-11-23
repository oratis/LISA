import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chatControlOptions, parseChatControls } from "./chat-controls.js";

describe("chatControlOptions", () => {
  test("filters models by credentials, respects LISA_CHAT_MODELS, and attaches supported efforts", () => {
    const options = chatControlOptions("claude-sonnet-4-6", "auto", {
      ANTHROPIC_API_KEY: "ant-key",
      OPENAI_API_KEY: "oa-key",
      LISA_CHAT_MODELS:
        " claude-sonnet-4-6 , claude-haiku-4-5 , gpt-6-astra , https://bad , gemini-2.5-flash ",
    });

    assert.deepEqual(options.permissions, ["smart", "ask", "full"]);
    assert.equal(options.defaultModel, "claude-sonnet-4-6");
    assert.deepEqual(options.models, [
      { id: "claude-sonnet-4-6", efforts: ["low", "medium", "high"] },
      { id: "claude-haiku-4-5", efforts: [] },
      { id: "gpt-6-astra", efforts: ["low", "medium", "high", "xhigh"] },
    ]);
  });

  test("omits default OpenAI models when LISA_BASE_URL points at a custom endpoint", () => {
    const options = chatControlOptions("custom-model", "warden", {
      LISA_BASE_URL: "https://llm.local/v1",
      LISA_API_KEY: "local-key",
    });

    assert.deepEqual(options.permissions, ["smart", "ask"]);
    assert.deepEqual(options.models, [{ id: "custom-model", efforts: [] }]);
  });

  test("recognizes dated gpt-6-astra and Claude 5+ efforts", () => {
    const options = chatControlOptions("claude-opus-5-0", "ask", {
      ANTHROPIC_API_KEY: "ant-key",
      OPENAI_API_KEY: "oa-key",
      LISA_CHAT_MODELS: "gpt-6-astra-2026-10-01,gpt-4o",
    });

    assert.deepEqual(options.permissions, ["ask"]);
    assert.deepEqual(options.models, [
      { id: "claude-opus-5-0", efforts: ["low", "medium", "high"] },
      { id: "gpt-6-astra-2026-10-01", efforts: ["low", "medium", "high", "xhigh"] },
      { id: "gpt-4o", efforts: [] },
    ]);
  });
});

describe("parseChatControls", () => {
  const options = chatControlOptions("claude-sonnet-4-6", "warden", {
    ANTHROPIC_API_KEY: "ant-key",
    LISA_CHAT_MODELS: "claude-haiku-4-5",
  });

  test("defaults to the first permitted mode when omitted", () => {
    assert.deepEqual(parseChatControls(undefined, options), { permission: "smart" });
  });

  test("accepts valid permission, optional model, and compatible effort", () => {
    assert.deepEqual(parseChatControls({ permission: "ask", effort: "low" }, options), {
      permission: "ask",
      effort: "low",
    });
    assert.deepEqual(
      parseChatControls({ permission: "smart", model: "claude-haiku-4-5" }, options),
      { permission: "smart", model: "claude-haiku-4-5" },
    );
  });

  test("rejects malformed shapes, permission escalation, unlisted models, and invalid efforts", () => {
    assert.throws(() => parseChatControls(null, options), /invalid_chat_controls/);
    assert.throws(() => parseChatControls([], options), /invalid_chat_controls/);
    assert.throws(
      () => parseChatControls({ permission: "smart", extra: true }, options),
      /invalid_chat_controls/,
    );
    assert.throws(() => parseChatControls({ permission: "full" }, options), /chat_permission/);
    assert.throws(
      () => parseChatControls({ permission: "smart", model: "gpt-4o" }, options),
      /chat_model_unavailable/,
    );
    assert.throws(
      () =>
        parseChatControls(
          { permission: "smart", model: "claude-haiku-4-5", effort: "high" },
          options,
        ),
      /chat_effort_unavailable/,
    );
    assert.throws(
      () => parseChatControls({ permission: "smart", effort: "xhigh" }, options),
      /chat_effort_unavailable/,
    );
  });
});
