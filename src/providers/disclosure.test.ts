import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { recipientForModel, aiDisclosure } from "./disclosure.js";
import { OPENAI_COMPAT_PRESETS } from "./registry.js";

// detectProvider/resolveDefaultModel consult process.env directly, so clear the
// routing vars that would otherwise leak a dev's shell into the answers.
const ENV_KEYS = [
  "LISA_BASE_URL",
  "LISA_PROVIDER",
  "LISA_MODEL",
  "LISA_EDITION",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "ZHIPU_API_KEY",
  "LISA_MANAGED_SESSION",
  "LISA_MANAGED_BASE",
] as const;
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

describe("recipientForModel — names the company that actually receives the turn", () => {
  test("the cloud demo's own setup (glm-4.6 + ZHIPU_API_KEY) names Zhipu, not OpenAI", () => {
    const r = recipientForModel("glm-4.6", { ZHIPU_API_KEY: "k" });
    assert.equal(r?.name, "Zhipu AI (GLM)");
    assert.equal(r?.endpoint, "open.bigmodel.cn");
    assert.equal(r?.region, "China");
    assert.ok(r?.policyUrl.startsWith("https://"));
  });

  test("claude-* with a key names Anthropic", () => {
    const r = recipientForModel("claude-sonnet-4-6", { ANTHROPIC_API_KEY: "k" });
    assert.equal(r?.name, "Anthropic PBC");
    assert.equal(r?.endpoint, "api.anthropic.com");
  });

  test("an ANTHROPIC_BASE_URL relay is disclosed as the host that really receives it", () => {
    const r = recipientForModel("claude-sonnet-4-6", {
      ANTHROPIC_API_KEY: "k",
      ANTHROPIC_BASE_URL: "https://anthropic-relay-xyz.run.app",
    });
    assert.equal(r?.endpoint, "anthropic-relay-xyz.run.app");
  });

  test("an unconfigured provider is still disclosed — the request reaches it and 401s", () => {
    // Withholding the name because no key is set would hide a host that the
    // data genuinely travels to.
    assert.equal(recipientForModel("glm-4.6", {})?.endpoint, "open.bigmodel.cn");
    assert.equal(
      recipientForModel("claude-sonnet-4-6", {})?.endpoint,
      "api.anthropic.com",
    );
  });

  test("a preset match is terminal, exactly as resolveProvider treats it", () => {
    // OPENAI_API_KEY is set, but glm-4.6 routes to Zhipu's preset regardless —
    // naming OpenAI would disclose a company that never sees the data.
    const r = recipientForModel("glm-4.6", { OPENAI_API_KEY: "k" });
    assert.equal(r?.name, "Zhipu AI (GLM)");
    assert.equal(r?.endpoint, "open.bigmodel.cn");
  });

  test("managed inference discloses the LISA gateway — the hop that receives it first", () => {
    const r = recipientForModel("claude-sonnet-4-6", {
      LISA_MANAGED_SESSION: "sess",
      LISA_MANAGED_BASE: "https://cloud.meetlisa.ai",
    });
    assert.equal(r?.endpoint, "cloud.meetlisa.ai");
    assert.match(r?.name ?? "", /LISA Cloud/);
  });

  test("a BYO key beats the managed gateway, and the disclosure follows", () => {
    const r = recipientForModel("claude-sonnet-4-6", {
      LISA_MANAGED_SESSION: "sess",
      ANTHROPIC_API_KEY: "k",
    });
    assert.equal(r?.name, "Anthropic PBC");
  });

  test("a custom base URL discloses the host and claims nothing else about it", () => {
    const r = recipientForModel("llama3", {
      LISA_BASE_URL: "http://localhost:11434/v1",
    });
    assert.equal(r?.endpoint, "localhost:11434");
    assert.equal(r?.region, "");
    assert.equal(r?.policyUrl, "");
  });

  test("a malformed base URL degrades instead of throwing", () => {
    const r = recipientForModel("x", { LISA_BASE_URL: "not a url" });
    assert.equal(r?.endpoint, "not a url");
  });

  test("every OpenAI-compatible preset can be disclosed with a name and an endpoint", () => {
    for (const preset of OPENAI_COMPAT_PRESETS) {
      const model = `${preset.modelPrefixes[0]}test`;
      const r = recipientForModel(model, { [preset.apiKeyEnv]: "k" });
      assert.ok(r, `${preset.name} produced no recipient`);
      assert.ok(r.policyUrl.startsWith("https://"), `${preset.name} has no policy link`);
      assert.ok(r.name.length > 0, `${preset.name} has no display name`);
      assert.ok(r.endpoint.length > 0, `${preset.name} has no endpoint`);
    }
  });
});

describe("aiDisclosure — the payload the iOS consent screen reads", () => {
  test("hosted edition reports cloud + managed, and names the live provider", () => {
    process.env.LISA_EDITION = "cloud";
    process.env.LISA_MODEL = "glm-4.6";
    process.env.ZHIPU_API_KEY = "k";
    const d = aiDisclosure();
    assert.equal(d.edition, "cloud");
    assert.equal(d.managed, true);
    assert.equal(d.recipients.length, 1);
    assert.equal(d.recipients[0]?.name, "Zhipu AI (GLM)");
    assert.equal(d.recipients[0]?.model, "glm-4.6");
  });

  test("a Mac reports the mac edition and its own (unmanaged) routing", () => {
    process.env.LISA_MODEL = "glm-4.6";
    const d = aiDisclosure();
    assert.equal(d.edition, "mac");
    assert.equal(d.managed, false);
    assert.equal(d.recipients[0]?.name, "Zhipu AI (GLM)");
  });

  test("carries the operator policy URL the app links to", () => {
    assert.equal(aiDisclosure().policyUrl, "https://meetlisa.ai/privacy");
  });
});
