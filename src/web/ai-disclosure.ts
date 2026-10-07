import { isCloud } from "../edition.js";
import { OPENAI_COMPAT_PRESETS } from "../providers/registry.js";
import { cloudWebToolsEnabled } from "../tools/cloud_web.js";

/**
 * Non-AI third parties that receive data when Lisa uses her web tools in a
 * chat turn. They belong in the same list the client shows before a message is
 * sent ("who receives your data"): `web_search` sends the search text — which
 * the model derives from the conversation — to DuckDuckGo, and `web_fetch`
 * requests a URL from whatever site it names. Neither sends account
 * identifiers, and both leave from the server's address, not the user's.
 *
 * The iOS consent record is the exact recipient list, so a deployment that
 * turns the web tools on (or off again) re-prompts on the next message — which
 * is the point: the hosted edition must not start sending queries to a new
 * third party under a consent that never named it.
 */
export const WEB_SEARCH_RECIPIENT = "DuckDuckGo (web search queries)";
export const WEB_FETCH_RECIPIENT = "Websites Lisa opens for you (page requests)";

/** Web-tool recipients for the chat surface this process serves. */
export function webToolRecipients(env: NodeJS.ProcessEnv = process.env): string[] {
  // Local edition: the owner's chat has always had both tools. Hosted edition:
  // only once the operator has opted in (LISA_CLOUD_WEB_TOOLS=1) — with the
  // variable unset the list is exactly what it was before the tools existed.
  if (isCloud(env) && !cloudWebToolsEnabled(env)) return [];
  return [WEB_SEARCH_RECIPIENT, WEB_FETCH_RECIPIENT];
}

/** Public recipient names only. Never serialize a configured URL's credentials,
 * query, path, or the API key while explaining who may process chat context. */
export function aiRecipients(model: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const recipients = new Set<string>();
  for (const value of [model, ...(env.LISA_MODEL_FALLBACK ?? "").split(",")]) {
    const m = value.trim().toLowerCase();
    if (!m) continue;
    const preset = OPENAI_COMPAT_PRESETS.find((p) =>
      p.modelPrefixes.some((s) => m.startsWith(s.toLowerCase())),
    );
    if (m.startsWith("claude-")) recipients.add("Anthropic");
    else if (m.startsWith("gemini-")) recipients.add("Google Gemini");
    else if (preset) recipients.add(preset.name);
    else if (/^(gpt-|o[134]|chatgpt-)/.test(m) || env.LISA_PROVIDER === "openai")
      recipients.add("OpenAI");
    else if (!env.LISA_BASE_URL)
      recipients.add(env.LISA_PROVIDER === "gemini" ? "Google Gemini" : "Anthropic");
  }
  // Alternate models/tools can use any configured provider on this instance.
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) recipients.add("Anthropic");
  if (env.OPENAI_API_KEY) recipients.add("OpenAI");
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) recipients.add("Google Gemini");
  for (const p of OPENAI_COMPAT_PRESETS) if (env[p.apiKeyEnv]) recipients.add(p.name);
  for (const key of [
    "LISA_BASE_URL",
    "ANTHROPIC_BASE_URL",
    "OPENAI_BASE_URL",
    "LISA_MANAGED_BASE",
  ]) {
    if (!env[key]) continue;
    try {
      recipients.add(`Configured AI service (${new URL(env[key]).hostname})`);
    } catch {
      recipients.add("Custom AI service (ask your server operator for its identity)");
    }
  }
  if (env.LISA_MANAGED_SESSION) recipients.add("LISA Cloud");
  for (const recipient of webToolRecipients(env)) recipients.add(recipient);
  return [...recipients].sort();
}
