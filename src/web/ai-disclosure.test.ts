import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WEB_FETCH_RECIPIENT,
  WEB_SEARCH_RECIPIENT,
  aiRecipients,
  webToolRecipients,
} from "./ai-disclosure.js";

const WEB = [WEB_SEARCH_RECIPIENT, WEB_FETCH_RECIPIENT];

test("AI disclosure includes the model, configured providers and fallback recipients", () => {
  assert.deepEqual(
    aiRecipients("glm-4.6", { ANTHROPIC_API_KEY: "secret", LISA_MODEL_FALLBACK: "gpt-4o,glm-4.6" }),
    ["Anthropic", "OpenAI", "Zhipu (GLM)", ...WEB].sort(),
  );
});

test("custom provider disclosure never contains credentials, path or query", () => {
  assert.deepEqual(
    aiRecipients("local-model", {
      LISA_BASE_URL: "https://user:secret@models.example/private?key=secret",
    }),
    ["Configured AI service (models.example)", ...WEB].sort(),
  );
});

test("managed and custom Anthropic routes are disclosed alongside model identity", () => {
  assert.deepEqual(
    aiRecipients("claude-sonnet-4-6", {
      LISA_MANAGED_SESSION: "secret",
      ANTHROPIC_BASE_URL: "https://gateway.example/v1",
    }),
    ["Anthropic", "Configured AI service (gateway.example)", "LISA Cloud", ...WEB].sort(),
  );
});

test("hosted edition discloses the web tools' third parties while they are enabled", () => {
  assert.deepEqual(aiRecipients("gemini-2.5-flash", { LISA_EDITION: "cloud" }), [
    WEB_SEARCH_RECIPIENT,
    "Google Gemini",
    WEB_FETCH_RECIPIENT,
  ]);
  assert.deepEqual(webToolRecipients({ LISA_EDITION: "cloud" }), WEB);
});

test("the kill switch removes them from the hosted disclosure", () => {
  for (const off of ["0", "false", "off"]) {
    const env = { LISA_EDITION: "cloud", LISA_CLOUD_WEB_TOOLS: off };
    assert.deepEqual(aiRecipients("gemini-2.5-flash", env), ["Google Gemini"]);
    assert.deepEqual(webToolRecipients(env), []);
  }
});

test("the local edition always discloses them — the kill switch is cloud-only", () => {
  assert.deepEqual(webToolRecipients({}), WEB);
  assert.deepEqual(webToolRecipients({ LISA_CLOUD_WEB_TOOLS: "0" }), WEB);
});

test("disclosure and capability agree: listed iff the cloud chat profile has the tools", async () => {
  const { toolsForCapabilityProfile } = await import("./capabilities.js");
  const tools = ["soul_read", "web_search", "web_fetch"].map((name) => ({
    name,
    description: name,
    inputSchema: { type: "object" },
    execute: async () => "",
  }));
  const before = process.env.LISA_CLOUD_WEB_TOOLS;
  try {
    for (const flag of [undefined, "0"]) {
      if (flag === undefined) delete process.env.LISA_CLOUD_WEB_TOOLS;
      else process.env.LISA_CLOUD_WEB_TOOLS = flag;
      const available = toolsForCapabilityProfile(tools, "cloud-chat").some(
        (tool) => tool.name === "web_search" || tool.name === "web_fetch",
      );
      const disclosed =
        webToolRecipients({ LISA_EDITION: "cloud", LISA_CLOUD_WEB_TOOLS: flag }).length > 0;
      assert.equal(disclosed, available, `LISA_CLOUD_WEB_TOOLS=${flag ?? "(unset)"}`);
    }
  } finally {
    if (before === undefined) delete process.env.LISA_CLOUD_WEB_TOOLS;
    else process.env.LISA_CLOUD_WEB_TOOLS = before;
  }
});
