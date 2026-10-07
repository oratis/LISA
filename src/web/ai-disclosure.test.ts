import { test } from "node:test";
import assert from "node:assert/strict";
import { aiRecipients } from "./ai-disclosure.js";

test("AI disclosure includes the model, configured providers and fallback recipients", () => {
  assert.deepEqual(
    aiRecipients("glm-4.6", { ANTHROPIC_API_KEY: "secret", LISA_MODEL_FALLBACK: "gpt-4o,glm-4.6" }),
    ["Anthropic", "OpenAI", "Zhipu (GLM)"],
  );
});

test("custom provider disclosure never contains credentials, path or query", () => {
  assert.deepEqual(
    aiRecipients("local-model", {
      LISA_BASE_URL: "https://user:secret@models.example/private?key=secret",
    }),
    ["Configured AI service (models.example)"],
  );
});

test("managed and custom Anthropic routes are disclosed alongside model identity", () => {
  assert.deepEqual(
    aiRecipients("claude-sonnet-4-6", {
      LISA_MANAGED_SESSION: "secret",
      ANTHROPIC_BASE_URL: "https://gateway.example/v1",
    }),
    ["Anthropic", "Configured AI service (gateway.example)", "LISA Cloud"],
  );
});
