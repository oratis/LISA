/**
 * Honor system HTTP/HTTPS proxy env vars for outbound LLM calls.
 *
 * Node's built-in fetch (undici) does NOT automatically pick up HTTPS_PROXY /
 * HTTP_PROXY environment variables. The Anthropic / OpenAI SDKs both use
 * fetch under the hood, so without this bridge a user behind a corporate
 * proxy or a region-blocked network sees the SDK fail with 403/timeout
 * even when their shell `curl` works fine.
 *
 * Two related issues addressed here:
 *   1. configureProxyFromEnv() — sets undici's global dispatcher to a
 *      ProxyAgent so all fetch() calls go via the proxy. Forces
 *      `Accept-Encoding: identity` on outbound requests because some local
 *      proxies (Clash, others) strip the `Content-Encoding: gzip` response
 *      header — without it, undici hands the SDK raw gzip bytes that
 *      silently fail JSON-parse.
 *   2. proxyAwareFetch — a fetch wrapper that re-injects
 *      `Content-Type: application/json` when the response body looks like
 *      JSON but the response header is missing (also a Clash artifact —
 *      it strips response headers through CONNECT tunnels). Without this,
 *      the Anthropic SDK falls back to text and `messages.create()` returns
 *      a string instead of a parsed object.
 *
 * Idempotent: configureProxyFromEnv() twice is safe.
 */
import { ProxyAgent, setGlobalDispatcher } from "undici";

let installed = false;

class IdentityEncodingProxyAgent extends ProxyAgent {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override dispatch(opts: any, handler: any): boolean {
    // Coerce headers to a flat object, then force Accept-Encoding=identity.
    // Works whether incoming headers are an object, array, or undefined.
    const incoming = opts.headers ?? {};
    const merged: Record<string, string> = {};
    if (Array.isArray(incoming)) {
      for (let i = 0; i < incoming.length; i += 2) {
        merged[String(incoming[i]).toLowerCase()] = String(incoming[i + 1]);
      }
    } else if (typeof incoming === "object") {
      for (const [k, v] of Object.entries(incoming)) {
        merged[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
      }
    }
    merged["accept-encoding"] = "identity";
    return super.dispatch({ ...opts, headers: merged }, handler);
  }
}

export function configureProxyFromEnv(opts: { log?: (msg: string) => void } = {}): void {
  const url =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy;
  if (!url) return;
  if (installed) return;
  try {
    setGlobalDispatcher(new IdentityEncodingProxyAgent(url));
    installed = true;
    opts.log?.(`[proxy] outbound HTTP routed through ${url} (Accept-Encoding=identity)`);
  } catch (err) {
    opts.log?.(
      `[proxy] failed to install ProxyAgent for ${url}: ${(err as Error).message}`,
    );
  }
}

/** True iff a proxy was successfully installed. */
export function isProxyInstalled(): boolean {
  return installed;
}

/**
 * Fetch wrapper to pass to LLM SDKs as their `fetch` option when running
 * behind a proxy that strips response headers. Re-injects
 * `Content-Type: application/json` when the body parses as JSON but the
 * header is missing — this is what makes Anthropic's `messages.create()`
 * return a parsed object instead of a string.
 *
 * Safe to use whether or not a proxy is installed: if no proxy is in
 * effect the body still has its real headers and we don't override.
 */
export const proxyAwareFetch: typeof fetch = async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> => {
  const r = await fetch(input, init);
  // Only patch when the proxy is in effect AND content-type is missing.
  if (!installed) return r;
  const ct = r.headers.get("content-type");
  if (ct) return r;
  // Body looks like JSON? Stream → text → re-construct with content-type set.
  const text = await r.text();
  const looksJson =
    text.trimStart().startsWith("{") || text.trimStart().startsWith("[");
  const newHeaders = new Headers(r.headers);
  if (looksJson) newHeaders.set("content-type", "application/json");
  return new Response(text, {
    status: r.status,
    statusText: r.statusText,
    headers: newHeaders,
  });
};
