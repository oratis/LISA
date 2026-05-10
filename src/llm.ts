import Anthropic from "@anthropic-ai/sdk";
import { proxyAwareFetch } from "./proxy-bootstrap.js";

export const DEFAULT_MODEL = "claude-sonnet-4-6";
export const DEFAULT_MAX_TOKENS = 16_000;

export function createAnthropicClient(opts: { apiKey?: string; baseURL?: string } = {}): Anthropic {
  return new Anthropic({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
    fetch: proxyAwareFetch,
  });
}
