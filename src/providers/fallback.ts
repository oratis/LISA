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

  /** Every link's model: any of them may serve a call. */
  get models(): readonly string[] {
    return this.chain.map((link) => link.model);
  }

  async runTurn(opts: ProviderRunOpts): Promise<ProviderResult> {
    let lastErr: unknown;
    for (let i = 0; i < this.chain.length; i++) {
      const link = this.chain[i]!;
      try {
        // Each link runs with its own model id; everything else is unchanged.
        // The result names the model that served it, so usage is priced at
        // that model's rate rather than the chain head's.
        const result = await link.provider.runTurn({ ...opts, model: link.model });
        return { ...result, model: result.model ?? link.model };
      } catch (err) {
        lastErr = err;
        const next = this.chain[i + 1];
        // The failed link was sent and may have been billed — after output,
        // even (a cut stream). Whoever counts spend hears of it before the
        // next link is tried, and may refuse it.
        if (
          next &&
          opts.onAttemptFailed &&
          !opts.onAttemptFailed({ model: link.model, error: err })
        ) {
          throw err;
        }
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
