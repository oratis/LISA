/**
 * Who this deployment actually sends a turn to — the machine-readable half of
 * App Store Guideline 5.1.1(i) / 5.1.2(i) ("identify who the data is sent to").
 *
 * Served unauthenticated at GET /api/ai/disclosure so Lisa Pocket can NAME the
 * recipient on its consent screen before the user signs in or types anything.
 * Deriving it from the live model means the disclosure follows a provider swap
 * on the server — an app release can't be the thing that keeps it truthful.
 *
 * Nothing here reads a key, only which key's env var is set. The answer is
 * public by design: it is the same fact the privacy policy states.
 */
import {
  findPreset,
  detectProvider,
  resolveDefaultModel,
  managedConfig,
  hasOwnCredentialsForModel,
} from "./registry.js";
import { isCloud } from "../edition.js";

export interface AIRecipient {
  /** Company that receives the message, as a person would name it. */
  name: string;
  /** The model the request is addressed to. */
  model: string;
  /** API host that receives it. */
  endpoint: string;
  /** Where that host processes it — part of an honest "who". */
  region: string;
  /** That company's own privacy policy. */
  policyUrl: string;
}

export interface AIDisclosure {
  edition: "cloud" | "mac";
  /** true = the operator's key pays (hosted); false = the user's own key. */
  managed: boolean;
  /** Empty only when a client can't be told — the app then says exactly that. */
  recipients: AIRecipient[];
  /** The operator's privacy policy. */
  policyUrl: string;
  /** ISO date this disclosure's content last changed. */
  updated: string;
}

interface Vendor {
  name: string;
  region: string;
  policyUrl: string;
}

// The three first-class providers are referenced directly (not only by preset
// name), so they are named constants rather than record lookups.
const ANTHROPIC: Vendor = {
  name: "Anthropic PBC",
  region: "United States",
  policyUrl: "https://www.anthropic.com/legal/privacy",
};
const OPENAI: Vendor = {
  name: "OpenAI, L.P.",
  region: "United States",
  policyUrl: "https://openai.com/policies/row-privacy-policy",
};
const GEMINI: Vendor = {
  name: "Google LLC (Gemini API)",
  region: "United States",
  policyUrl: "https://policies.google.com/privacy",
};

/** Vendor facts that a base URL alone doesn't carry. Keyed by registry name. */
const VENDORS: Record<string, Vendor> = {
  Anthropic: ANTHROPIC,
  OpenAI: OPENAI,
  "Google Gemini": GEMINI,
  DeepSeek: {
    name: "DeepSeek",
    region: "China",
    policyUrl: "https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html",
  },
  "Mistral AI": {
    name: "Mistral AI",
    region: "European Union",
    policyUrl: "https://mistral.ai/terms#privacy-policy",
  },
  "Perplexity (Sonar)": {
    name: "Perplexity AI",
    region: "United States",
    policyUrl: "https://www.perplexity.ai/hub/legal/privacy-policy",
  },
  "xAI Grok": {
    name: "xAI",
    region: "United States",
    policyUrl: "https://x.ai/legal/privacy-policy",
  },
  "Volcengine Ark (Doubao)": {
    name: "Volcengine (ByteDance)",
    region: "China",
    policyUrl: "https://www.volcengine.com/docs/6257/64934",
  },
  "Aliyun DashScope (Qwen)": {
    name: "Alibaba Cloud (DashScope)",
    region: "China",
    policyUrl: "https://www.alibabacloud.com/help/en/legal/latest/alibaba-cloud-international-website-privacy-policy",
  },
  "Moonshot (Kimi)": {
    name: "Moonshot AI",
    region: "China",
    policyUrl: "https://www.moonshot.cn/privacy",
  },
  "Zhipu (GLM)": {
    name: "Zhipu AI (GLM)",
    region: "China",
    policyUrl: "https://open.bigmodel.cn/dev/getprivacy",
  },
  "Stepfun (Step)": { name: "StepFun", region: "China", policyUrl: "https://www.stepfun.com/privacy" },
  "01.AI (Yi)": { name: "01.AI", region: "China", policyUrl: "https://www.lingyiwanwu.com/privacy" },
  Baichuan: { name: "Baichuan AI", region: "China", policyUrl: "https://www.baichuan-ai.com/privacy" },
  MiniMax: { name: "MiniMax", region: "Singapore", policyUrl: "https://www.minimax.io/privacy-policy" },
  "Tencent Hunyuan": {
    name: "Tencent Cloud (Hunyuan)",
    region: "China",
    policyUrl: "https://www.tencentcloud.com/document/product/301/17345",
  },
};

/** Host of a base URL, for display. Never throws on a malformed override. */
function hostOf(baseURL: string | undefined, fallback: string): string {
  if (!baseURL) return fallback;
  try {
    return new URL(baseURL).host;
  } catch {
    return fallback;
  }
}

/**
 * Resolve the recipient for one model, mirroring `resolveProvider` in
 * ./registry.ts branch for branch. It must: the disclosure is only true if it
 * names the host a request would ACTUALLY be addressed to.
 *
 * Deliberately independent of whether a key is configured. An unconfigured
 * provider still receives the request (and answers 401) — the data leaves the
 * machine either way, so it is disclosed either way.
 */
export function recipientForModel(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): AIRecipient | null {
  const provider = detectProvider(model, env);

  // Managed inference (B6): no own key + a signed-in session ⇒ the turn goes to
  // the LISA gateway, which forwards it to the real provider. The user's data
  // reaches us first, so we are the recipient to name here.
  const managed = managedConfig(env);
  if (managed && !hasOwnCredentialsForModel(model, env) && provider !== "gemini") {
    return {
      name: "LISA Cloud (managed inference gateway)",
      model,
      endpoint: hostOf(managed.base, managed.base),
      region: "United States",
      policyUrl: "https://meetlisa.ai/privacy",
    };
  }

  if (provider === "anthropic") {
    return { ...ANTHROPIC, model, endpoint: hostOf(env.ANTHROPIC_BASE_URL, "api.anthropic.com") };
  }
  if (provider === "gemini") {
    return {
      ...GEMINI,
      model,
      endpoint: hostOf(env.GEMINI_BASE_URL, "generativelanguage.googleapis.com"),
    };
  }

  // OpenAI-compatible. A preset match is TERMINAL in resolveProvider — glm-4.6
  // goes to open.bigmodel.cn whether or not ZHIPU_API_KEY is set, and naming
  // OpenAI here (because OPENAI_API_KEY happens to exist) would disclose a
  // company that never sees the data.
  const preset = findPreset(model);
  if (preset) {
    const v = VENDORS[preset.name];
    return {
      name: v?.name ?? preset.name,
      model,
      endpoint: hostOf(preset.baseURL, preset.baseURL),
      region: v?.region ?? "",
      policyUrl: v?.policyUrl ?? "",
    };
  }

  // A custom OpenAI-compatible base URL (Ollama, a self-hosted model, a proxy):
  // we know the host it goes to and nothing else. Say only that.
  if (env.LISA_BASE_URL) {
    const host = hostOf(env.LISA_BASE_URL, env.LISA_BASE_URL);
    return { name: `Custom endpoint (${host})`, model, endpoint: host, region: "", policyUrl: "" };
  }

  return { ...OPENAI, model, endpoint: hostOf(env.OPENAI_BASE_URL, "api.openai.com") };
}

/** The whole disclosure for this process. */
export function aiDisclosure(env: NodeJS.ProcessEnv = process.env): AIDisclosure {
  const cloud = isCloud(env);
  const model = env.LISA_MODEL?.trim() || resolveDefaultModel();
  const recipient = recipientForModel(model, env);
  return {
    edition: cloud ? "cloud" : "mac",
    managed: cloud,
    recipients: recipient ? [recipient] : [],
    policyUrl: "https://meetlisa.ai/privacy",
    updated: "2026-09-22",
  };
}
