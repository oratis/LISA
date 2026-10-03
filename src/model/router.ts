/**
 * Purpose-based model routing (plan W12, "分层路由").
 *
 * Watching, triage, classification and summarisation go to a small model;
 * chat, planning and execution stay on the model the user chose. The router
 * only ever answers "which model id" — credentials, provider construction and
 * (in cloud) admission, reservation and settlement stay where they are, keyed
 * by the id this returns.
 *
 * Config:
 *   LISA_MODEL        the strong model (unchanged meaning).
 *   LISA_MODEL_SMALL  the small model. A model id, or `local://[backend/]model`
 *                     for a model served by a local runtime (Ollama, LM Studio,
 *                     llama.cpp). Unset ⇒ a small model of the strong model's
 *                     own provider family is picked when one is known.
 *
 * The router never makes a background call MORE expensive or less available
 * than leaving it on the strong model: a small model without credentials is
 * skipped, and in the hosted edition a small model is used only when the price
 * table prices it explicitly, on the same billing tier or below, at no more
 * than the strong model's rate. Anything else falls back to the strong model.
 */
import { isCloud } from "../edition.js";
import { DEFAULT_MODEL } from "../llm.js";
import { explicitPriceForModel, priceForModel, type ModelPrice } from "../billing/prices.js";
import { OpenAIProvider } from "../providers/openai.js";
import { findPreset, hasCredentialsForModel, providerForModel } from "../providers/registry.js";
import type { Provider } from "../providers/types.js";
import { localEndpoint, parseLocalRef } from "./local.js";

export type ModelPurpose =
  "chat" | "plan" | "execute" | "triage" | "classify" | "summarize" | "watch";

export type ModelTierName = "strong" | "small";

/** Which tier each purpose runs on. Chat-facing work is never downgraded. */
export const PURPOSE_TIER: Readonly<Record<ModelPurpose, ModelTierName>> = {
  chat: "strong",
  plan: "strong",
  execute: "strong",
  triage: "small",
  classify: "small",
  summarize: "small",
  watch: "small",
};

export function tierForPurpose(purpose: ModelPurpose): ModelTierName {
  return PURPOSE_TIER[purpose];
}

type Env = Record<string, string | undefined>;

export type ModelFamily = "anthropic" | "gemini" | "openai" | "preset" | "custom";

/**
 * Provider family by model id alone. Deliberately narrower than
 * `detectProvider`: an id that only routes somewhere because of
 * LISA_BASE_URL / LISA_PROVIDER is "custom" here, and gets no auto-pick.
 */
export function modelFamily(model: string): ModelFamily {
  const m = model.trim().toLowerCase();
  if (m.startsWith("claude-")) return "anthropic";
  if (m.startsWith("gemini-")) return "gemini";
  if (/^(gpt-|o1|o3|o4|chatgpt-)/.test(m)) return "openai";
  if (findPreset(m)) return "preset";
  return "custom";
}

/**
 * The small model of each first-party family, and how to recognise a strong
 * model that is already small-class (so it is left alone).
 *
 * Ids checked against the providers' model lists and src/billing/prices.ts:
 * `claude-haiku-4-5` and `gpt-4o-mini` have explicit price rows;
 * `gemini-2.5-flash-lite` does not (v0.27.1 kept it on the conservative
 * fallback on purpose), which is why the hosted edition will not auto-route to
 * it — see `billingSafeInCloud`.
 */
const SMALL_BY_FAMILY: Partial<Record<ModelFamily, { model: string; alreadySmall: RegExp }>> = {
  anthropic: { model: "claude-haiku-4-5", alreadySmall: /haiku/ },
  gemini: { model: "gemini-2.5-flash-lite", alreadySmall: /flash-lite/ },
  openai: { model: "gpt-4o-mini", alreadySmall: /mini|nano/ },
};

/** The family's small model, or null when the strong model is already small or the family is unknown. */
export function autoSmallModel(strong: string): string | null {
  const entry = SMALL_BY_FAMILY[modelFamily(strong)];
  if (!entry) return null;
  const id = strong.trim().toLowerCase();
  if (id === entry.model || entry.alreadySmall.test(id)) return null;
  return entry.model;
}

function perTokenRate(price: ModelPrice): number {
  return price.inPerM + price.outPerM;
}

/**
 * Hosted-edition guard. Background work must not land on a model that bills
 * the user more, or that the free allowance cannot pay for: the candidate needs
 * its own row in the price table (an unknown id is priced at the premium
 * fallback), must not move from the standard tier to premium, and must not cost
 * more than the strong model on either input or output.
 */
export function billingSafeInCloud(candidate: string, strong: string): boolean {
  const price = explicitPriceForModel(candidate);
  if (!price) return false;
  const strongPrice = priceForModel(strong);
  if (price.tier === "premium" && strongPrice.tier === "standard") return false;
  return (
    price.inPerM <= strongPrice.inPerM &&
    price.outPerM <= strongPrice.outPerM &&
    perTokenRate(price) <= perTokenRate(strongPrice)
  );
}

export interface RouteContext {
  /**
   * The strong model in effect for this run (the CLI `--model`, a server's
   * configured model). Unset ⇒ LISA_MODEL, else the built-in default.
   */
  model?: string;
  env?: Env;
}

export type RouteSource =
  /** The purpose runs on the strong tier. */
  | "strong"
  /** LISA_MODEL_SMALL chose the model. */
  | "configured"
  /** The strong model's family small model was picked. */
  | "auto"
  /** A small-tier purpose that stayed on the strong model — `reason` says why. */
  | "strong-fallback";

export interface ModelRoute {
  purpose: ModelPurpose;
  tier: ModelTierName;
  model: string;
  source: RouteSource;
  reason?: string;
  /** Set when the model is served by a local runtime rather than a hosted API. */
  local?: { backend: string; baseURL: string; apiKey: string };
}

function strongModel(ctx: RouteContext, env: Env): string {
  return ctx.model?.trim() || env.LISA_MODEL?.trim() || DEFAULT_MODEL;
}

/** Decide the model for a purpose, with the reasoning attached. Pure given `env`. */
export function resolveRoute(purpose: ModelPurpose, ctx: RouteContext = {}): ModelRoute {
  const env = ctx.env ?? process.env;
  const strong = strongModel(ctx, env);
  const tier = tierForPurpose(purpose);
  if (tier === "strong") return { purpose, tier, model: strong, source: "strong" };

  const cloud = isCloud(env);
  const stay = (reason: string): ModelRoute => ({
    purpose,
    tier,
    model: strong,
    source: "strong-fallback",
    reason,
  });

  const configured = env.LISA_MODEL_SMALL?.trim();
  if (configured) {
    const local = parseLocalRef(configured);
    if (configured.startsWith("local://")) {
      if (!local) return stay("LISA_MODEL_SMALL is not a valid local:// reference");
      // A hosted instance has no local runtime, and a loopback base URL there
      // would be the service calling itself.
      if (cloud) return stay("local models are not available in the hosted edition");
      return {
        purpose,
        tier,
        model: local.model,
        source: "configured",
        local: { backend: local.backend, ...localEndpoint(local.backend, env) },
      };
    }
    if (configured === strong) return { purpose, tier, model: strong, source: "configured" };
    if (!hasCredentialsForModel(configured, env)) {
      return stay(`no credentials for LISA_MODEL_SMALL=${configured}`);
    }
    if (cloud && !billingSafeInCloud(configured, strong)) {
      return stay(`LISA_MODEL_SMALL=${configured} is not priced at or below ${strong}`);
    }
    return { purpose, tier, model: configured, source: "configured" };
  }

  const candidate = autoSmallModel(strong);
  if (!candidate) return stay("no smaller model is known for this model's family");
  if (!hasCredentialsForModel(candidate, env)) return stay(`no credentials for ${candidate}`);
  if (cloud && !billingSafeInCloud(candidate, strong)) {
    return stay(`${candidate} is not priced at or below ${strong}`);
  }
  return { purpose, tier, model: candidate, source: "auto" };
}

/** The model id for a purpose. */
export function routeModel(purpose: ModelPurpose, ctx: RouteContext = {}): string {
  return resolveRoute(purpose, ctx).model;
}

export interface BackgroundCall {
  model: string;
  /** Set only when the caller pinned one, or the route is a local runtime. */
  provider?: Provider;
  /** Null when the caller pinned a provider and no routing was applied. */
  route: ModelRoute | null;
}

/**
 * Model (and, when needed, provider) for a background call site such as mail
 * or feed classification.
 *
 * A caller that injects a provider has already bound it to its own model, so
 * nothing is rerouted there. Otherwise the strong model is the caller's
 * `model`, else LISA_MODEL, else the built-in default, and the purpose's tier
 * decides. For a hosted-API route `provider` is left unset on purpose: the
 * call site resolves it from the model id exactly as it did before.
 */
export function routeBackgroundCall(
  purpose: ModelPurpose,
  opts: { model?: string; provider?: Provider; env?: Env } = {},
): BackgroundCall {
  if (opts.provider) {
    return { model: opts.model ?? DEFAULT_MODEL, provider: opts.provider, route: null };
  }
  const route = resolveRoute(purpose, {
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  });
  return {
    model: route.model,
    ...(route.local ? { provider: providerForRoute(route) } : {}),
    route,
  };
}

/** The provider that serves a route — a local runtime's endpoint when the route names one. */
export function providerForRoute(route: ModelRoute): Provider {
  if (route.local) {
    return new OpenAIProvider({ baseURL: route.local.baseURL, apiKey: route.local.apiKey });
  }
  return providerForModel(route.model);
}
