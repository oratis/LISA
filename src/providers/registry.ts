import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import type { Provider } from "./types.js";

export type ProviderName = "anthropic" | "openai";

/**
 * OpenAI-compatible third-party preset table.
 *
 * Many providers (DeepSeek, Volcengine Ark, Moonshot/Kimi, Aliyun DashScope,
 * xAI, Zhipu, etc.) expose an OpenAI-compatible `/chat/completions` endpoint.
 * Lisa can talk to all of them through `OpenAIProvider` by overriding
 * baseURL + apiKey. This table makes that automatic when the model name
 * starts with a known prefix — no need to set LISA_PROVIDER manually.
 *
 * Resolution rules (see providerForModel below):
 *   1. claude-* / Anthropic models → AnthropicProvider (with optional ANTHROPIC_BASE_URL)
 *   2. gpt-* / o1 / o3 / o4 / chatgpt-* → OpenAIProvider (vanilla)
 *   3. Model matches a preset prefix → OpenAIProvider with preset's baseURL/apiKey
 *   4. LISA_BASE_URL set (catch-all override, e.g. Ollama / self-hosted) → OpenAIProvider
 *   5. LISA_PROVIDER=openai → OpenAIProvider (vanilla)
 *   6. Default → AnthropicProvider
 */
interface OpenAICompatPreset {
  /** Human-readable provider name. */
  name: string;
  /** Model name prefixes that route to this preset. */
  modelPrefixes: string[];
  /** OpenAI-compatible base URL. */
  baseURL: string;
  /** Environment variable that holds this provider's API key. */
  apiKeyEnv: string;
}

export const OPENAI_COMPAT_PRESETS: OpenAICompatPreset[] = [
  {
    name: "DeepSeek",
    modelPrefixes: ["deepseek-"],
    baseURL: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
  },
  {
    // Volcengine Ark uses arbitrary "endpoint IDs" (ep-...) and the doubao-* family.
    name: "Volcengine Ark (Doubao)",
    modelPrefixes: ["doubao-", "ep-"],
    baseURL: "https://ark.cn-beijing.volces.com/api/v3",
    apiKeyEnv: "ARK_API_KEY",
  },
  {
    name: "Aliyun DashScope (Qwen)",
    modelPrefixes: ["qwen-", "qwen2", "qwen3"],
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY",
  },
  {
    name: "Moonshot (Kimi)",
    modelPrefixes: ["moonshot-", "kimi-"],
    baseURL: "https://api.moonshot.cn/v1",
    apiKeyEnv: "MOONSHOT_API_KEY",
  },
  {
    name: "xAI Grok",
    modelPrefixes: ["grok-"],
    baseURL: "https://api.x.ai/v1",
    apiKeyEnv: "XAI_API_KEY",
  },
  {
    name: "Zhipu (GLM)",
    modelPrefixes: ["glm-", "chatglm-"],
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    apiKeyEnv: "ZHIPU_API_KEY",
  },
];

function findPreset(model: string): OpenAICompatPreset | null {
  for (const p of OPENAI_COMPAT_PRESETS) {
    if (p.modelPrefixes.some((pre) => model.startsWith(pre))) return p;
  }
  return null;
}

export function detectProvider(model: string): ProviderName {
  if (model.startsWith("claude-")) return "anthropic";
  if (
    model.startsWith("gpt-") ||
    model.startsWith("o1") ||
    model.startsWith("o3") ||
    model.startsWith("o4") ||
    model.startsWith("chatgpt-")
  ) {
    return "openai";
  }
  // Any model that matches a third-party preset routes through OpenAI provider.
  if (findPreset(model)) return "openai";
  // Generic LISA_BASE_URL override (Ollama, self-hosted, custom proxy) routes
  // through OpenAI provider regardless of model name.
  if (process.env.LISA_BASE_URL) return "openai";
  if (process.env.LISA_PROVIDER === "openai") return "openai";
  return "anthropic";
}

export function makeProvider(name: ProviderName): Provider {
  switch (name) {
    case "anthropic":
      return new AnthropicProvider({
        apiKey: process.env.ANTHROPIC_API_KEY,
        baseURL: process.env.ANTHROPIC_BASE_URL,
      });
    case "openai":
      return new OpenAIProvider({
        apiKey: process.env.OPENAI_API_KEY,
        baseURL: process.env.OPENAI_BASE_URL,
      });
  }
}

/**
 * Resolve a Provider instance for a given model name. Looks up preset →
 * LISA_BASE_URL override → vanilla provider, in that order.
 */
export function providerForModel(model: string): Provider {
  const provider = detectProvider(model);
  if (provider === "anthropic") {
    return new AnthropicProvider({
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: process.env.ANTHROPIC_BASE_URL,
    });
  }
  // OpenAI / OpenAI-compatible. Three nested fallbacks for baseURL + apiKey:
  const preset = findPreset(model);
  if (preset) {
    return new OpenAIProvider({
      baseURL: preset.baseURL,
      apiKey: process.env[preset.apiKeyEnv],
    });
  }
  if (process.env.LISA_BASE_URL) {
    // Catch-all (Ollama, self-hosted, unknown providers).
    return new OpenAIProvider({
      baseURL: process.env.LISA_BASE_URL,
      // LISA_API_KEY first, fall back to OPENAI_API_KEY for compatibility.
      apiKey: process.env.LISA_API_KEY ?? process.env.OPENAI_API_KEY,
    });
  }
  // Vanilla OpenAI.
  return new OpenAIProvider({
    baseURL: process.env.OPENAI_BASE_URL,
    apiKey: process.env.OPENAI_API_KEY,
  });
}

/** For docs / CLI listing. */
export function listConfiguredProviders(): Array<{ name: string; configured: boolean }> {
  const out: Array<{ name: string; configured: boolean }> = [
    { name: "Anthropic", configured: !!process.env.ANTHROPIC_API_KEY },
    { name: "OpenAI", configured: !!process.env.OPENAI_API_KEY },
  ];
  for (const p of OPENAI_COMPAT_PRESETS) {
    out.push({ name: p.name, configured: !!process.env[p.apiKeyEnv] });
  }
  if (process.env.LISA_BASE_URL) {
    out.push({
      name: `Custom (LISA_BASE_URL=${process.env.LISA_BASE_URL})`,
      configured: true,
    });
  }
  return out;
}
