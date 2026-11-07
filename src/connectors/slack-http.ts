import { remoteFetch, type McpFetch } from "../mcp/http.js";
import { ConnectorError } from "./types.js";

export const SLACK_ORIGIN = "https://slack.com";
export const SLACK_READ_SCOPES = [
  "channels:read",
  "channels:history",
  "groups:read",
  "groups:history",
] as const;
export function assertSlackScopes(scopes: unknown): asserts scopes is string[] {
  if (
    !Array.isArray(scopes) ||
    scopes.length !== SLACK_READ_SCOPES.length ||
    new Set(scopes).size !== scopes.length ||
    !SLACK_READ_SCOPES.every((scope) => scopes.includes(scope))
  )
    throw new ConnectorError("slack_read_scope_required");
}
const methods = [
  "oauth.v2.access",
  "auth.test",
  "auth.revoke",
  "users.conversations",
  "conversations.info",
  "conversations.history",
  "conversations.replies",
];
export const slackEndpointAllowed = (url: URL, method: string) =>
  url.origin === SLACK_ORIGIN &&
  !url.username &&
  !url.password &&
  !url.hash &&
  !url.search &&
  method === "POST" &&
  methods.some((name) => url.pathname === "/api/" + name);
export interface SlackReply {
  data: Record<string, unknown>;
  scopes?: string[];
}
export type SlackHttp = (
  method: string,
  signal: AbortSignal,
  init?: { token?: string; form?: Record<string, string> },
) => Promise<SlackReply>;
export function slackHttp(fetcher?: (signal: AbortSignal) => McpFetch): SlackHttp {
  return async (method, signal, init = {}) => {
    if (!methods.includes(method)) throw new ConnectorError("slack_invalid_endpoint");
    try {
      const res = await (
        fetcher?.(signal) ??
        remoteFetch(slackEndpointAllowed, signal, undefined, "slack_reauthorization_required")
      )(SLACK_ORIGIN + "/api/" + method, {
        method: "POST",
        signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          ...(init.token ? { Authorization: "Bearer " + init.token } : {}),
        },
        body: new URLSearchParams(init.form ?? {}).toString(),
      });
      if (!res.ok)
        throw new ConnectorError(
          res.status === 429 ? "slack_rate_limited" : "slack_request_failed",
        );
      const data: unknown = await res.json();
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new ConnectorError("slack_invalid_response");
      const r = data as Record<string, unknown>;
      if (r.ok !== true) {
        const error = String(r.error);
        throw new ConnectorError(
          [
            "invalid_auth",
            "not_authed",
            "token_expired",
            "token_revoked",
            "account_inactive",
            "invalid_refresh_token",
            "invalid_grant",
          ].includes(error)
            ? "slack_reauthorization_required"
            : ["missing_scope", "invalid_scope"].includes(error)
              ? "slack_read_scope_required"
              : ["channel_not_found", "not_in_channel", "team_access_not_granted"].includes(error)
                ? "slack_channel_unavailable"
                : error === "ratelimited"
                  ? "slack_rate_limited"
                  : ["access_denied", "no_permission", "accesslimited"].includes(error)
                    ? "slack_access_denied"
                    : "slack_request_failed",
        );
      }
      const header = res.headers.get("x-oauth-scopes");
      return {
        data: r,
        ...(header !== null
          ? {
              scopes: header
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            }
          : {}),
      };
    } catch (e) {
      if (e instanceof ConnectorError) {
        if (e.code.startsWith("slack_") || e.code === "request_cancelled") throw e;
        const map: Record<string, string> = {
          mcp_rate_limited: "slack_rate_limited",
          mcp_access_denied: "slack_access_denied",
          mcp_response_too_large: "slack_response_too_large",
          mcp_unavailable: "slack_unavailable",
        };
        throw new ConnectorError(map[e.code] ?? "slack_request_failed");
      }
      throw new ConnectorError(signal.aborted ? "request_cancelled" : "slack_invalid_response");
    }
  };
}
