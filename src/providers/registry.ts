import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import type { Provider } from "./types.js";

export type ProviderName = "anthropic" | "openai";

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
  if (process.env.LISA_PROVIDER === "openai") return "openai";
  return "anthropic";
}

export function makeProvider(name: ProviderName): Provider {
  switch (name) {
    case "anthropic":
      return new AnthropicProvider();
    case "openai":
      return new OpenAIProvider({
        baseURL: process.env.OPENAI_BASE_URL,
      });
  }
}

export function providerForModel(model: string): Provider {
  return makeProvider(detectProvider(model));
}
