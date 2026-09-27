import { OPENAI_COMPAT_PRESETS } from "../providers/registry.js";

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
  return [...recipients].sort();
}
