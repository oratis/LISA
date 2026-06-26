import { AnthropicProvider } from "./anthropic.js";
import { GeminiProvider } from "./gemini.js";
import { OpenAIProvider } from "./openai.js";
import { FallbackProvider } from "./fallback.js";
import { DEFAULT_MODEL } from "../llm.js";
import type { Provider } from "./types.js";

export type ProviderName = "anthropic" | "openai" | "gemini";

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
  // ── International ─────────────────────────────────────────────────
  {
    name: "DeepSeek",
    modelPrefixes: ["deepseek-"],
    baseURL: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
  },
  {
    name: "Mistral AI",
    // mistral-*, codestral-*, magistral-*, ministral-*, pixtral-*
    modelPrefixes: ["mistral-", "codestral-", "magistral-", "ministral-", "pixtral-"],
    baseURL: "https://api.mistral.ai/v1",
    apiKeyEnv: "MISTRAL_API_KEY",
  },
  {
    name: "Perplexity (Sonar)",
    modelPrefixes: ["sonar-", "sonar"],
    baseURL: "https://api.perplexity.ai",
    apiKeyEnv: "PERPLEXITY_API_KEY",
  },
  {
    name: "xAI Grok",
    modelPrefixes: ["grok-"],
    baseURL: "https://api.x.ai/v1",
    apiKeyEnv: "XAI_API_KEY",
  },
  // ── Chinese ──────────────────────────────────────────────────────
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
    name: "Zhipu (GLM)",
    modelPrefixes: ["glm-", "chatglm-"],
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    apiKeyEnv: "ZHIPU_API_KEY",
  },
  {
    name: "Stepfun (Step)",
    modelPrefixes: ["step-"],
    baseURL: "https://api.stepfun.com/v1",
    apiKeyEnv: "STEPFUN_API_KEY",
  },
  {
    name: "01.AI (Yi)",
    modelPrefixes: ["yi-"],
    baseURL: "https://api.lingyiwanwu.com/v1",
    apiKeyEnv: "LINGYI_API_KEY",
  },
  {
    name: "Baichuan",
    // Model IDs ship in title-case (Baichuan2-Turbo, Baichuan4); match is case-insensitive.
    modelPrefixes: ["baichuan-", "baichuan2", "baichuan3", "baichuan4"],
    baseURL: "https://api.baichuan-ai.com/v1",
    apiKeyEnv: "BAICHUAN_API_KEY",
  },
  {
    name: "MiniMax",
    // abab- family + the newer MiniMax-* models; case-insensitive.
    modelPrefixes: ["abab", "minimax-"],
    baseURL: "https://api.minimax.io/v1",
    apiKeyEnv: "MINIMAX_API_KEY",
  },
  {
    name: "Tencent Hunyuan",
    modelPrefixes: ["hunyuan-"],
    baseURL: "https://api.hunyuan.cloud.tencent.com/v1",
    apiKeyEnv: "HUNYUAN_API_KEY",
  },
];

/**
 * Case-insensitive prefix match. Several Chinese providers ship model IDs in
 * mixed case (Baichuan2-Turbo, MiniMax-Text-01) and users typing the canonical
 * lowercase form shouldn't have to remember a vendor-specific capitalization.
 */
function findPreset(model: string): OpenAICompatPreset | null {
  const lower = model.toLowerCase();
  for (const p of OPENAI_COMPAT_PRESETS) {
    if (p.modelPrefixes.some((pre) => lower.startsWith(pre.toLowerCase()))) return p;
  }
  return null;
}

export function detectProvider(model: string): ProviderName {
  const m = model.toLowerCase();
  if (m.startsWith("claude-")) return "anthropic";
  if (m.startsWith("gemini-")) return "gemini";
  if (
    m.startsWith("gpt-") ||
    m.startsWith("o1") ||
    m.startsWith("o3") ||
    m.startsWith("o4") ||
    m.startsWith("chatgpt-")
  ) {
    return "openai";
  }
  // Any model that matches a third-party preset routes through OpenAI provider.
  if (findPreset(model)) return "openai";
  // Generic LISA_BASE_URL override (Ollama, self-hosted, custom proxy) routes
  // through OpenAI provider regardless of model name.
  if (process.env.LISA_BASE_URL) return "openai";
  if (process.env.LISA_PROVIDER === "openai") return "openai";
  if (process.env.LISA_PROVIDER === "gemini") return "gemini";
  return "anthropic";
}

/**
 * Anthropic auth from env. ANTHROPIC_AUTH_TOKEN (sent as `Authorization: Bearer`,
 * for an Anthropic-compatible gateway/proxy) takes precedence over
 * ANTHROPIC_API_KEY (`x-api-key`), matching Claude Code's precedence. Pure.
 */
export function resolveAnthropicAuth(
  env: Record<string, string | undefined> = process.env,
): { apiKey?: string; authToken?: string } {
  const authToken = env.ANTHROPIC_AUTH_TOKEN?.trim();
  if (authToken) return { authToken };
  return { apiKey: env.ANTHROPIC_API_KEY };
}

/**
 * Does `env` carry credentials for the provider that MODEL routes to? Mirrors
 * resolveProvider's auth resolution exactly, so the CLI key-gate matches the key
 * the provider will actually read — e.g. a `glm-*` model needs ZHIPU_API_KEY (its
 * preset), not OPENAI_API_KEY. Used by the birth + run gates. Pure.
 *
 * (detectProvider consults process.env for the LISA_BASE_URL / LISA_PROVIDER
 * routing rules; the per-key lookups below read the passed `env`.)
 */
export function hasCredentialsForModel(
  model: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const provider = detectProvider(model);
  if (provider === "anthropic") {
    return !!(env.ANTHROPIC_AUTH_TOKEN?.trim() || env.ANTHROPIC_API_KEY);
  }
  if (provider === "gemini") {
    return !!(env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY);
  }
  // openai / openai-compatible — same precedence as resolveProvider.
  const preset = findPreset(model);
  if (preset) return !!env[preset.apiKeyEnv];
  if (env.LISA_BASE_URL) {
    return !!(env.LISA_API_KEY ?? env.TAKO_KEY ?? env.OPENAI_API_KEY);
  }
  return !!env.OPENAI_API_KEY;
}

export function makeProvider(name: ProviderName): Provider {
  switch (name) {
    case "anthropic":
      return new AnthropicProvider({
        ...resolveAnthropicAuth(),
        baseURL: process.env.ANTHROPIC_BASE_URL,
      });
    case "openai":
      return new OpenAIProvider({
        apiKey: process.env.OPENAI_API_KEY,
        baseURL: process.env.OPENAI_BASE_URL,
      });
    case "gemini":
      return new GeminiProvider({
        apiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY,
        baseURL: process.env.GEMINI_BASE_URL,
      });
  }
}

/**
 * Resolve a SINGLE Provider instance for a model name. Looks up preset →
 * LISA_BASE_URL override → vanilla provider, in that order. (No fallback chain —
 * that's providerForModel's job.)
 */
function resolveProvider(model: string): Provider {
  const provider = detectProvider(model);
  if (provider === "anthropic") {
    return new AnthropicProvider({
      ...resolveAnthropicAuth(),
      baseURL: process.env.ANTHROPIC_BASE_URL,
    });
  }
  if (provider === "gemini") {
    return new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY,
      baseURL: process.env.GEMINI_BASE_URL,
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
    // Catch-all (Ollama, self-hosted, the TakoAPI gateway, unknown providers).
    return new OpenAIProvider({
      baseURL: process.env.LISA_BASE_URL,
      // LISA_API_KEY first, then TAKO_KEY (so pointing LISA_BASE_URL at
      // https://takoapi.com/v1 just works), then OPENAI_API_KEY for compat.
      apiKey: process.env.LISA_API_KEY ?? process.env.TAKO_KEY ?? process.env.OPENAI_API_KEY,
    });
  }
  // Vanilla OpenAI.
  return new OpenAIProvider({
    baseURL: process.env.OPENAI_BASE_URL,
    apiKey: process.env.OPENAI_API_KEY,
  });
}

/**
 * Resolve the provider for a model, wrapping it in a FallbackProvider when
 * LISA_MODEL_FALLBACK lists alternate models to try if the primary errors.
 * Drop-in for the old single-provider behavior (no env → identical).
 */
export function providerForModel(model: string): Provider {
  const fallbacks = (process.env.LISA_MODEL_FALLBACK ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (fallbacks.length === 0) return resolveProvider(model);
  const chain = [model, ...fallbacks].map((m) => ({ model: m, provider: resolveProvider(m) }));
  return new FallbackProvider(chain);
}

/**
 * Pick the default model when the user didn't pass --model. An explicit local
 * default (LISA_MODEL, e.g. set by `lisa model use`) wins; otherwise auto-detect
 * from the single configured cloud key so a one-key setup works with no flags.
 */
export function resolveDefaultModel(): string {
  if (process.env.LISA_MODEL?.trim()) return process.env.LISA_MODEL.trim();
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return DEFAULT_MODEL;
  if (process.env.OPENAI_API_KEY) return "gpt-4o";
  return DEFAULT_MODEL;
}

/** For docs / CLI listing. */
export function listConfiguredProviders(): Array<{ name: string; configured: boolean }> {
  const out: Array<{ name: string; configured: boolean }> = [
    {
      name: "Anthropic",
      configured: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    },
    { name: "OpenAI", configured: !!process.env.OPENAI_API_KEY },
    {
      name: "Google Gemini",
      configured: !!(process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY),
    },
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
