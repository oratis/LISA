import { remoteFetch, remoteJson, type McpFetch } from "../mcp/http.js";
import { ConnectorError } from "./types.js";
export const NOTION_ORIGIN = "https://api.notion.com";
export const NOTION_VERSION = "2026-03-11";
const ID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
export const notionEndpointAllowed = (url: URL, method: string) =>
  url.origin === NOTION_ORIGIN &&
  ((method === "POST" &&
    !url.search &&
    ["/v1/oauth/token", "/v1/oauth/introspect", "/v1/oauth/revoke", "/v1/search"].includes(
      url.pathname,
    )) ||
    (method === "GET" &&
      (url.pathname === "/v1/users/me" ||
        new RegExp("^/v1/(?:pages/" + ID + "|blocks/" + ID + "(?:/children)?)$").test(
          url.pathname,
        )) &&
      [...url.searchParams.keys()].every((k) => ["page_size", "start_cursor"].includes(k))));
export type NotionHttp = (
  path: string,
  signal: AbortSignal,
  init?: { token?: string; basic?: { clientId: string; clientSecret: string }; json?: object },
) => Promise<Record<string, unknown>>;
export function notionHttp(fetcher?: (signal: AbortSignal) => McpFetch): NotionHttp {
  return async (path, signal, init = {}) => {
    const url = NOTION_ORIGIN + path,
      method = init.json ? "POST" : "GET";
    if (!notionEndpointAllowed(new URL(url), method))
      throw new ConnectorError("notion_invalid_endpoint");
    try {
      return await remoteJson(
        fetcher?.(signal) ??
          remoteFetch(notionEndpointAllowed, signal, undefined, "notion_reauthorization_required"),
        url,
        {
          method,
          signal,
          headers: {
            Accept: "application/json",
            "Notion-Version": NOTION_VERSION,
            ...(init.json ? { "Content-Type": "application/json" } : {}),
            ...(init.basic
              ? {
                  Authorization:
                    "Basic " +
                    Buffer.from(init.basic.clientId + ":" + init.basic.clientSecret).toString(
                      "base64",
                    ),
                }
              : init.token
                ? { Authorization: "Bearer " + init.token }
                : {}),
          },
          ...(init.json ? { body: JSON.stringify(init.json) } : {}),
        },
      );
    } catch (error) {
      if (error instanceof ConnectorError) {
        if (error.httpStatus === 400 && path === "/v1/oauth/token")
          throw new ConnectorError("notion_reauthorization_required");
        if (error.httpStatus === 404) throw new ConnectorError("notion_page_unavailable");
        if (error.httpStatus === 403) throw new ConnectorError("notion_access_denied");
        if (error.httpStatus === 429) throw new ConnectorError("notion_rate_limited");
        const own = NOTION_ERRORS[error.code];
        if (own) throw new ConnectorError(own, error.httpStatus);
      }
      throw error;
    }
  };
}
/** remoteFetch reports Linear's `mcp_*` codes; a Notion card needs Notion wording. */
const NOTION_ERRORS: Readonly<Record<string, string>> = {
  mcp_invalid_endpoint: "notion_invalid_endpoint",
  mcp_redirect_refused: "notion_request_failed",
  mcp_request_failed: "notion_request_failed",
  mcp_access_denied: "notion_access_denied",
  mcp_rate_limited: "notion_rate_limited",
  mcp_response_too_large: "notion_response_too_large",
  mcp_invalid_response: "notion_invalid_response",
  mcp_unavailable: "notion_unavailable",
};
