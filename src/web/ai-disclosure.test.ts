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

test("hosted edition, default: the recipient list is what it was before the web tools existed", () => {
  // Variable unset, empty or unparseable ⇒ tools off ⇒ nothing new is disclosed
  // and no existing consent record is invalidated.
  for (const value of [undefined, "", "0", "false", "off", "enabled"]) {
    const env = { LISA_EDITION: "cloud", LISA_CLOUD_WEB_TOOLS: value };
    assert.deepEqual(aiRecipients("gemini-2.5-flash", env), ["Google Gemini"], String(value));
    assert.deepEqual(webToolRecipients(env), [], String(value));
  }
});

test("hosted edition discloses the web tools' third parties once they are switched on", () => {
  for (const value of ["1", "true", "on", "yes"]) {
    const env = { LISA_EDITION: "cloud", LISA_CLOUD_WEB_TOOLS: value };
    assert.deepEqual(aiRecipients("gemini-2.5-flash", env), [
      WEB_SEARCH_RECIPIENT,
      "Google Gemini",
      WEB_FETCH_RECIPIENT,
    ]);
    assert.deepEqual(webToolRecipients(env), WEB);
  }
});

test("the local edition always discloses them — the switch is cloud-only", () => {
  assert.deepEqual(webToolRecipients({}), WEB);
  assert.deepEqual(webToolRecipients({ LISA_CLOUD_WEB_TOOLS: "0" }), WEB);
  assert.deepEqual(webToolRecipients({ LISA_EDITION: "mac", LISA_CLOUD_WEB_TOOLS: "" }), WEB);
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
    const seen: boolean[] = [];
    for (const flag of [undefined, "", "0", "off", "garbage", "1", "true", "on", "yes"]) {
      if (flag === undefined) delete process.env.LISA_CLOUD_WEB_TOOLS;
      else process.env.LISA_CLOUD_WEB_TOOLS = flag;
      const available = toolsForCapabilityProfile(tools, "cloud-chat").some(
        (tool) => tool.name === "web_search" || tool.name === "web_fetch",
      );
      const disclosed =
        webToolRecipients({ LISA_EDITION: "cloud", LISA_CLOUD_WEB_TOOLS: flag }).length > 0;
      assert.equal(disclosed, available, `LISA_CLOUD_WEB_TOOLS=${flag ?? "(unset)"}`);
      seen.push(available);
    }
    // Both states were exercised — the agreement is not vacuous.
    assert.deepEqual(seen, [false, false, false, false, false, true, true, true, true]);
  } finally {
    if (before === undefined) delete process.env.LISA_CLOUD_WEB_TOOLS;
    else process.env.LISA_CLOUD_WEB_TOOLS = before;
  }
});
