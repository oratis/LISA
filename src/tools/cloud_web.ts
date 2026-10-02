/**
 * Hosted-edition governance for the two outbound web tools.
 *
 * `web_search` and `web_fetch` are the only cloud tools that make the service
 * itself open a connection to a destination the model chose. They are admitted
 * to the cloud allow-list ONLY through this module, which adds what a
 * multi-tenant, internet-facing deployment needs on top of the SSRF guard in
 * web_fetch.ts:
 *
 *  - a global kill switch (`LISA_CLOUD_WEB_TOOLS=0`), checked both when the
 *    tool list is built and again on every call;
 *  - per-tenant hourly limits, keyed by the server-derived uid of the active
 *    request scope (never by anything the client or the model supplies);
 *  - a hard wall-clock deadline per call;
 *  - a stricter outbound policy (standard web ports only).
 *
 * Everything here fails CLOSED: no tenant scope, a full limiter table or an
 * unparseable limit all refuse the call rather than letting it through.
 */

export const CLOUD_WEB_TOOL_NAMES: ReadonlySet<string> = new Set(["web_search", "web_fetch"]);

export type CloudWebToolKind = "search" | "fetch";

export interface CloudWebLimits {
  searchesPerWindow: number;
  fetchesPerWindow: number;
  windowMs: number;
  maxTenants: number;
}

export const DEFAULT_CLOUD_WEB_LIMITS: CloudWebLimits = {
  searchesPerWindow: 30,
  fetchesPerWindow: 60,
  windowMs: 60 * 60_000,
  maxTenants: 10_000,
};

/** The kill switch. Anything other than an explicit "off" value leaves the tools on. */
export function cloudWebToolsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = (env.LISA_CLOUD_WEB_TOOLS ?? "").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}
