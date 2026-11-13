/** Bounded, DNS-pinned HTTP for reviewed remote MCP services and their OAuth metadata. */
import {
  pinnedTransport,
  resolvePublicAddresses,
  readResponseTextCapped,
  withDeadline,
  type SafeFetchDependencies,
} from "../tools/web_fetch.js";
import { ConnectorError } from "../connectors/types.js";
export type McpFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;
export function remoteFetch(
  allowed: (url: URL, method: string) => boolean,
  signal: AbortSignal,
  network?: Pick<SafeFetchDependencies, "lookup" | "transport">,
  reauthorizationCode = "mcp_reauthorization_required",
): McpFetch {
  return async (raw, init = {}) => {
    try {
      return await withDeadline(
        AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]),
        30_000,
        async (deadline) => {
          const url = new URL(String(raw)),
            method = (init.method ?? "GET").toUpperCase();
          if (
            url.protocol !== "https:" ||
            url.username ||
            url.password ||
            url.port ||
            url.hash ||
            !allowed(url, method)
          )
            throw new ConnectorError("mcp_invalid_endpoint");
          const addresses = await resolvePublicAddresses(url.hostname, network?.lookup);
          deadline!.throwIfAborted();
          const res = await (network?.transport ?? pinnedTransport)(
            url.href,
            { ...init, method, redirect: "manual", signal: deadline },
            addresses[0]!,
          );
          if (res.status >= 300 && res.status < 400) {
            await res.body?.cancel();
            throw new ConnectorError("mcp_redirect_refused");
          }
          if (!res.ok && ![202, 204, 405].includes(res.status)) {
            await res.body?.cancel();
            throw new ConnectorError(
              res.status === 401 || (res.status === 400 && url.pathname === "/token")
                ? reauthorizationCode
                : res.status === 429
                  ? "mcp_rate_limited"
                  : res.status === 403
                    ? "mcp_access_denied"
                    : "mcp_request_failed",
              res.status,
            );
          }
          if ([202, 204, 405].includes(res.status)) {
            await res.body?.cancel();
            return new Response(null, { status: res.status, headers: res.headers });
          }
          // Deliver SSE replies as they arrive. A server may keep the POST stream
          // open after the JSON-RPC result. Bound its lifetime and bytes independently.
          if (
            res.body &&
            res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ===
              "text/event-stream"
          ) {
            let bytes = 0;
            const limited = new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                bytes += chunk.byteLength;
                if (bytes > 1_000_000) throw new ConnectorError("mcp_response_too_large");
                controller.enqueue(chunk);
              },
            });
            const streamSignal = AbortSignal.any([
              signal,
              ...(init.signal ? [init.signal] : []),
              AbortSignal.timeout(30_000),
            ]);
            return new Response(res.body.pipeThrough(limited, { signal: streamSignal }), {
              status: res.status,
              headers: res.headers,
            });
          }
          const body = await readResponseTextCapped(res, 1_000_000);
          if (body.truncated) throw new ConnectorError("mcp_response_too_large");
          return new Response(body.text, { status: res.status, headers: res.headers });
        },
      );
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError(signal.aborted ? "request_cancelled" : "mcp_unavailable");
    }
  };
}
export async function remoteJson(
  fetcher: McpFetch,
  url: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const res = await fetcher(url, init);
  try {
    const value: unknown = await res.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new ConnectorError("mcp_invalid_response");
  }
}
