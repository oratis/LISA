import { ConnectorError } from "../types.js";
import {
  pinnedTransport,
  resolvePublicAddresses,
  readResponseTextCapped,
  withDeadline,
  type DnsLookupAll,
  type PinnedTransport,
} from "../../tools/web_fetch.js";

export type Row = Record<string, unknown>;
export function fail(code = "connector_invalid_response"): never {
  throw new ConnectorError(code);
}
export function row(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Row;
}
export function rows(value: unknown): Row[] {
  if (!Array.isArray(value)) fail();
  return value.map(row);
}
export function string(value: unknown, max = 500): string {
  if (typeof value !== "string") fail();
  return value.slice(0, max);
}
export function identifier(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 700 || /\p{Cc}/u.test(value))
    fail();
  return value;
}
export function bound(actual: unknown, expected: string) {
  if (actual !== expected) fail("workspace_resource_changed");
}
export type Http = (
  url: URL,
  init: RequestInit,
  signal: AbortSignal,
  text?: boolean,
) => Promise<unknown>;
// Token endpoints of every supported provider (Microsoft, Atlassian, Todoist, Dropbox, Figma).
const tokenPath =
  /^\/(?:[^/]+\/oauth2\/v2\.0\/token|oauth(?:2)?\/(?:access_token|token)|v1\/oauth\/(?:refresh|token))$/;
/** Lookup and transport are injectable only so tests can exercise this exact error mapping. */
export function createWorkspaceHttp(
  deps: { lookup?: DnsLookupAll; transport?: PinnedTransport } = {},
): Http {
  const transport = deps.transport ?? pinnedTransport;
  return async (url, init, signal, text) => {
    try {
      return await withDeadline(signal, 30000, async (deadline) => {
        if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash)
          fail("workspace_invalid_endpoint");
        const [ip] = await resolvePublicAddresses(url.hostname, deps.lookup);
        deadline!.throwIfAborted();
        let response = await transport(
          url.href,
          { ...init, redirect: "manual", signal: deadline },
          ip!,
        );
        // Box returns a signed CDN capability URL. Only this download endpoint may redirect;
        // re-check public DNS at every hop and never forward the API bearer to the CDN.
        if (
          text &&
          url.origin === "https://api.box.com" &&
          /^\/2\.0\/files\/\d+\/content$/.test(url.pathname)
        ) {
          for (let hop = 0; [301, 302, 303, 307, 308].includes(response.status) && hop < 3; hop++) {
            const location = response.headers.get("location");
            await response.body?.cancel();
            if (!location) fail("workspace_invalid_endpoint");
            const target = new URL(location);
            if (
              target.protocol !== "https:" ||
              target.username ||
              target.password ||
              target.port ||
              target.hash ||
              !/^[a-z0-9.-]+\.boxcloud\.com$/.test(target.hostname)
            )
              fail("workspace_invalid_endpoint");
            const [address] = await resolvePublicAddresses(target.hostname, deps.lookup);
            deadline!.throwIfAborted();
            response = await transport(
              target.href,
              { redirect: "manual", signal: deadline },
              address!,
            );
          }
        }
        if (!response.ok) {
          // A dead refresh token must drop the connection, whatever status carries it:
          // Atlassian answers a reused rotating refresh token with 403 invalid_grant.
          if ([400, 401, 403].includes(response.status) && tokenPath.test(url.pathname)) {
            const body = await readResponseTextCapped(response, 8192);
            let code: unknown;
            if (!body.truncated) {
              try {
                code = row(JSON.parse(body.text)).error;
              } catch {
                /* Some providers return plain-text errors. */
              }
            }
            if (
              code === "invalid_grant" ||
              code === "invalid_refresh_token" ||
              code === "unauthorized_client"
            )
              fail("workspace_reauthorize");
            if (code === "invalid_scope") fail("workspace_scope_mismatch");
            fail(response.status === 401 ? "workspace_reauthorize" : "workspace_request_failed");
          }
          await response.body?.cancel();
          if (response.status === 401) fail("workspace_reauthorize");
          if (response.status === 429) fail("workspace_rate_limited");
          if (response.status === 403 || response.status === 404) fail("workspace_inaccessible");
          fail("workspace_request_failed");
        }
        const body = await readResponseTextCapped(response, 1_000_000);
        if (body.truncated) fail("workspace_response_too_large");
        return text ? body.text : JSON.parse(body.text);
      });
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      fail(signal.aborted ? "request_cancelled" : "workspace_request_failed");
    }
  };
}
export const workspaceHttp: Http = createWorkspaceHttp();

export const apiOrigins = {
  box: "https://api.box.com",
  microsoft: "https://graph.microsoft.com",
  atlassian: "https://api.atlassian.com",
  figma: "https://api.figma.com",
  todoist: "https://api.todoist.com",
  dropbox: "https://api.dropboxapi.com",
} as const;
// Provider adapters construct every path. No tool input can supply a URL, RPC name, or HTTP method.
export class Reader {
  constructor(
    readonly vendor: keyof typeof apiOrigins,
    private token: string,
    readonly signal: AbortSignal,
    private http: Http,
  ) {}
  async get(path: string, query: Record<string, string> = {}) {
    const url = new URL(path, apiOrigins[this.vendor]);
    if (url.origin !== apiOrigins[this.vendor] || !path.startsWith("/") || path.startsWith("//"))
      fail("workspace_invalid_endpoint");
    url.search = new URLSearchParams(query).toString();
    return row(
      await this.http(url, { headers: { Authorization: "Bearer " + this.token } }, this.signal),
    );
  }
  async atlassianSites() {
    if (this.vendor !== "atlassian") fail("workspace_invalid_endpoint");
    return rows(
      await this.http(
        new URL("https://api.atlassian.com/oauth/token/accessible-resources"),
        { headers: { Authorization: "Bearer " + this.token } },
        this.signal,
      ),
    );
  }
  async dropbox(
    method: "users/get_current_account" | "files/list_folder" | "files/get_metadata",
    args: Row | null,
  ) {
    if (this.vendor !== "dropbox") fail("workspace_invalid_endpoint");
    return row(
      await this.http(
        new URL("https://api.dropboxapi.com/2/" + method),
        {
          method: "POST",
          headers: { Authorization: "Bearer " + this.token, "Content-Type": "application/json" },
          body: JSON.stringify(args),
        },
        this.signal,
      ),
    );
  }
  async dropboxText(id: string) {
    if (this.vendor !== "dropbox") fail("workspace_invalid_endpoint");
    return string(
      await this.http(
        new URL("https://content.dropboxapi.com/2/files/download"),
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + this.token,
            "Dropbox-API-Arg": JSON.stringify({ path: id }),
          },
        },
        this.signal,
        true,
      ),
      1_000_000,
    );
  }
  async boxText(id: string, version: string) {
    if (this.vendor !== "box" || !/^\d{1,25}$/.test(id) || !/^\d{1,25}$/.test(version))
      fail("workspace_invalid_endpoint");
    return string(
      await this.http(
        new URL("https://api.box.com/2.0/files/" + id + "/content?version=" + version),
        { headers: { Authorization: "Bearer " + this.token } },
        this.signal,
        true,
      ),
      1_000_000,
    );
  }
  async graphText(download: unknown) {
    if (this.vendor !== "microsoft" || typeof download !== "string")
      fail("workspace_content_unavailable");
    const u = new URL(download);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.port ||
      u.hash ||
      !/\.(?:sharepoint\.com|1drv\.com|storage\.live\.com)$/.test(u.hostname)
    )
      fail("workspace_invalid_endpoint");
    // Graph's capability URL is already authenticated. Never forward the Graph bearer.
    return string(await this.http(u, {}, this.signal, true), 1_000_000);
  }
}
