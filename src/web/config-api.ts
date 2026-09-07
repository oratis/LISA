/**
 * The provider-configuration API behind `/api/config/status` and
 * `/api/config/save` (T-9).
 *
 * Lisa routes 15+ model families (see providers/registry.ts), but the config
 * popup only ever knew about ANTHROPIC_API_KEY and OPENAI_API_KEY: a user
 * running `--model glm-4` had to hand-edit ~/.lisa/config.env, and the setup
 * screen reported "not configured" for a perfectly configured install.
 *
 * The list is DERIVED from the preset table rather than restated here, so a
 * provider added to the registry shows up in the UI with no second edit and
 * no chance of the two drifting.
 *
 * The write side is a whitelist, not a filter: an unknown env key is a 400,
 * never a silent skip and never a write. This endpoint writes to config.env
 * (0600) and into process.env, so "which names may be written" has to be a
 * closed set — otherwise a save body is an arbitrary environment injection
 * into the running server (PATH, NODE_OPTIONS, LISA_EDITION…). Fail closed.
 */
import { OPENAI_COMPAT_PRESETS } from "../providers/registry.js";

export interface ProviderConfigInfo {
  /** Stable slug for the UI (`anthropic`, `openai`, `deepseek`, …). */
  id: string;
  /** The environment variable that holds this provider's key. */
  envKey: string;
  /** Human-readable name. */
  label: string;
  /** Model name prefixes routed to this provider. */
  modelPrefixes: string[];
  /** Whether a key is present in the environment right now. */
  configured: boolean;
}

/** The three first-class providers, which are not in the preset table. */
const BUILT_INS: Omit<ProviderConfigInfo, "configured">[] = [
  {
    id: "anthropic",
    envKey: "ANTHROPIC_API_KEY",
    label: "Anthropic",
    modelPrefixes: ["claude-"],
  },
  {
    id: "openai",
    envKey: "OPENAI_API_KEY",
    label: "OpenAI",
    modelPrefixes: ["gpt-", "o1", "o3", "o4", "chatgpt-"],
  },
  {
    id: "gemini",
    envKey: "GEMINI_API_KEY",
    label: "Google Gemini",
    modelPrefixes: ["gemini-"],
  },
];

/**
 * Env vars that are not a provider's key but still belong to this screen:
 * the OpenAI-compatible escape hatch (a base URL + key for anything not in
 * the preset table) and the default model.
 */
const EXTRA_WRITABLE_KEYS = ["LISA_API_KEY", "LISA_BASE_URL", "LISA_MODEL"] as const;

/** `DEEPSEEK_API_KEY` → `deepseek`. */
function slugForEnvKey(envKey: string): string {
  return envKey.replace(/_API_KEY$/, "").toLowerCase().replace(/_/g, "-");
}

function isConfigured(envKey: string, env: NodeJS.ProcessEnv): boolean {
  if (env[envKey]?.trim()) return true;
  // Anthropic accepts an OAuth-style token as well as an API key, and
  // hasOwnCredentialsForModel already treats them as equivalent.
  if (envKey === "ANTHROPIC_API_KEY") return !!env.ANTHROPIC_AUTH_TOKEN?.trim();
  if (envKey === "GEMINI_API_KEY") return !!env.GOOGLE_API_KEY?.trim();
  return false;
}

/** Every provider the setup screen can configure, built-ins first. */
export function providerConfigList(env: NodeJS.ProcessEnv = process.env): ProviderConfigInfo[] {
  const presets = OPENAI_COMPAT_PRESETS.map((p) => ({
    id: slugForEnvKey(p.apiKeyEnv),
    envKey: p.apiKeyEnv,
    label: p.name,
    modelPrefixes: [...p.modelPrefixes],
  }));
  return [...BUILT_INS, ...presets].map((p) => ({
    ...p,
    configured: isConfigured(p.envKey, env),
  }));
}

/**
 * The closed set of env names `/api/config/save` may write. Derived from the
 * provider list, so a new preset is writable the moment it is registered.
 */
export function writableConfigKeys(): Set<string> {
  const keys = new Set<string>(EXTRA_WRITABLE_KEYS);
  for (const p of providerConfigList()) keys.add(p.envKey);
  return keys;
}

export interface ConfigStatusPayload {
  /** Legacy field: "is Lisa usable at all". Kept for older clients. */
  configured: boolean;
  /** Legacy fields, kept so the old popup keeps working. */
  anthropic: boolean;
  openai: boolean;
  providers: ProviderConfigInfo[];
  /** The model this server was started with. */
  model: string;
}

export function configStatusPayload(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): ConfigStatusPayload {
  const providers = providerConfigList(env);
  return {
    // "configured" now means ANY provider has a key — the old meaning
    // ("ANTHROPIC_API_KEY is set") made a working DeepSeek install look
    // unconfigured and re-showed the setup popup forever.
    configured: providers.some((p) => p.configured),
    anthropic: providers.find((p) => p.id === "anthropic")?.configured ?? false,
    openai: providers.find((p) => p.id === "openai")?.configured ?? false,
    providers,
    model,
  };
}

export type ConfigSaveParse =
  | { ok: true; updates: Record<string, string> }
  | { ok: false; status: number; error: string };

/** Printable ASCII, no spaces, long enough to be a real credential. */
const KEY_SHAPE = /^[\x21-\x7e]{20,}$/;
const MODEL_SHAPE = /^[A-Za-z0-9._:@/-]{1,120}$/;

/**
 * Validate a `/api/config/save` body into the env updates to write.
 *
 * Accepts the new `{keys:{ENV_KEY:value}, model?, baseUrl?}` shape and the
 * legacy `{anthropicKey, openaiKey}` / `{anthropic, openai}` bodies, so an
 * older client (or a cached page) keeps working across the deploy.
 *
 * Error strings name the offending KEY, never the value — a rejected body is
 * usually a mistyped credential and it must not end up in a log or a browser
 * console.
 */
export function parseConfigSave(raw: unknown): ConfigSaveParse {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, status: 400, error: "expected a JSON object" };
  }
  const body = raw as Record<string, unknown>;
  const updates: Record<string, string> = {};
  const allowed = writableConfigKeys();

  const put = (envKey: string, value: unknown, label: string): ConfigSaveParse | null => {
    if (typeof value !== "string") {
      return { ok: false, status: 400, error: `${label} must be a string` };
    }
    const trimmed = value.trim();
    if (!trimmed) return { ok: false, status: 400, error: `${label} is empty` };
    if (envKey === "LISA_BASE_URL") {
      let u: URL;
      try {
        u = new URL(trimmed);
      } catch {
        return { ok: false, status: 400, error: "baseUrl is not a valid URL" };
      }
      if (u.protocol !== "https:" && u.protocol !== "http:") {
        return { ok: false, status: 400, error: "baseUrl must be http or https" };
      }
    } else if (envKey === "LISA_MODEL") {
      if (!MODEL_SHAPE.test(trimmed)) {
        return { ok: false, status: 400, error: "model name looks malformed" };
      }
    } else if (!KEY_SHAPE.test(trimmed)) {
      return { ok: false, status: 400, error: `${label} looks malformed` };
    }
    updates[envKey] = trimmed;
    return null;
  };

  // New shape.
  if (body.keys !== undefined) {
    if (body.keys === null || typeof body.keys !== "object" || Array.isArray(body.keys)) {
      return { ok: false, status: 400, error: "keys must be an object" };
    }
    for (const [envKey, value] of Object.entries(body.keys as Record<string, unknown>)) {
      if (!allowed.has(envKey)) {
        return { ok: false, status: 400, error: `unknown config key: ${envKey}` };
      }
      const bad = put(envKey, value, envKey);
      if (bad) return bad;
    }
  }
  if (body.model !== undefined) {
    const bad = put("LISA_MODEL", body.model, "model");
    if (bad) return bad;
  }
  if (body.baseUrl !== undefined) {
    const bad = put("LISA_BASE_URL", body.baseUrl, "baseUrl");
    if (bad) return bad;
  }

  // Legacy shapes.
  for (const [field, envKey] of [
    ["anthropicKey", "ANTHROPIC_API_KEY"],
    ["openaiKey", "OPENAI_API_KEY"],
    ["anthropic", "ANTHROPIC_API_KEY"],
    ["openai", "OPENAI_API_KEY"],
  ] as const) {
    const value = body[field];
    // Legacy clients send both fields with one blank; an empty legacy field
    // means "not provided", unlike an explicit empty in `keys`.
    if (typeof value !== "string" || !value.trim()) continue;
    const bad = put(envKey, value, field);
    if (bad) return bad;
  }

  if (Object.keys(updates).length === 0) {
    return { ok: false, status: 400, error: "no keys provided" };
  }
  return { ok: true, updates };
}
