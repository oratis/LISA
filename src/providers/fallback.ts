/**
 * Fallback provider (PLAN_MODEL_v1.0 M3).
 *
 * Wraps a chain of {model, provider} links. runTurn tries each in order; if one
 * throws (network error, rate limit, provider outage), it moves to the next.
 * Configured by LISA_MODEL_FALLBACK (a comma-separated list of model ids) — the
 * primary model is the chain head, the fallbacks follow.
 *
 * It implements the same Provider interface, so the agent loop is unaware it's
 * talking to a chain rather than a single provider.
 */
import type { Provider, ProviderResult, ProviderRunOpts } from "./types.js";

export interface FallbackLink {
  model: string;
  provider: Provider;
}

export class FallbackProvider implements Provider {
  readonly name = "fallback";
  constructor(private chain: FallbackLink[]) {
    if (chain.length === 0) throw new Error("FallbackProvider requires at least one link");
  }

  async runTurn(opts: ProviderRunOpts): Promise<ProviderResult> {
    let lastErr: unknown;
    for (let i = 0; i < this.chain.length; i++) {
      const link = this.chain[i]!;
      try {
        // Each link runs with its own model id; everything else is unchanged.
        return await link.provider.runTurn({ ...opts, model: link.model });
      } catch (err) {
        lastErr = err;
        const next = this.chain[i + 1];
        if (next) {
          console.error(
            `[provider] "${link.model}" failed (${(err as Error).message?.slice(0, 120)}) — ` +
              `falling back to "${next.model}"`,
          );
        }
      }
    }
    throw lastErr;
  }
}
