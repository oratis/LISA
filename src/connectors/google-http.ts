import {
  pinnedTransport,
  readResponseTextCapped,
  resolvePublicAddresses,
  withDeadline,
  type SafeFetchDependencies,
} from "../tools/web_fetch.js";
import { ConnectorError } from "./types.js";

export type GoogleHttp = (
  url: string,
  signal: AbortSignal,
  init?: { token?: string; form?: URLSearchParams; json?: object },
) => Promise<Record<string, unknown>>;

/** Fixed Google origins, pinned public DNS, no redirects, bounded JSON, no raw errors. */
export function googleHttp(
  network?: Pick<SafeFetchDependencies, "lookup" | "transport">,
): GoogleHttp {
  return async (raw, signal, init = {}) => {
    try {
      return await withDeadline(signal, 20_000, async (deadline) => {
        const url = new URL(raw);
        if (
          url.protocol !== "https:" ||
          url.port ||
          url.username ||
          url.password ||
          ![
            "oauth2.googleapis.com",
            "openidconnect.googleapis.com",
            "www.googleapis.com",
            "gmail.googleapis.com",
          ].includes(url.hostname)
        )
          throw new ConnectorError("google_invalid_endpoint");
        const addresses = await resolvePublicAddresses(url.hostname, network?.lookup);
        deadline?.throwIfAborted();
        const response = await (network?.transport ?? pinnedTransport)(
          url.href,
          {
            method: init.form || init.json ? "POST" : "GET",
            redirect: "manual",
            signal: deadline,
            headers: {
              Accept: "application/json",
              ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
              ...(init.form
                ? { "Content-Type": "application/x-www-form-urlencoded" }
                : init.json
                  ? { "Content-Type": "application/json" }
                  : {}),
            },
            body: init.form?.toString() ?? (init.json ? JSON.stringify(init.json) : undefined),
          },
          addresses[0]!,
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new ConnectorError(
            response.status === 401 || (response.status === 400 && url.pathname === "/token")
              ? "google_reauthorization_required"
              : response.status === 403
                ? "google_access_denied"
                : response.status === 429
                  ? "google_rate_limited"
                  : "google_request_failed",
          );
        }
        const body = await readResponseTextCapped(response, 512_000);
        if (body.truncated) throw new ConnectorError("google_response_too_large");
        const data: unknown = JSON.parse(body.text);
        if (!data || typeof data !== "object" || Array.isArray(data))
          throw new ConnectorError("google_invalid_response");
        return data as Record<string, unknown>;
      });
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError(signal.aborted ? "request_cancelled" : "google_unavailable");
    }
  };
}
