import fs from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "../../soul/lock.js";
import { lisaHome } from "../../paths.js";
import { atomicWrite } from "../../fs-utils.js";
import { loopbackAuthorization } from "../oauth-loopback.js";
import { workspaceApps, workspaceIds, workspaceScopes, type CloudId } from "./catalog.js";
import { fail, identifier, row, type Http } from "./http.js";

export interface AppClient {
  clientId: string;
  clientSecret?: string;
  tenant?: string;
}
export interface Grant {
  provider: CloudId;
  client: AppClient;
  access: string;
  refresh?: string;
  expires: number;
  subject?: string;
}
const microsoft = "https://login.microsoftonline.com/";
const tenantId = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
export function endpoints(id: CloudId, client: AppClient) {
  switch (workspaceApps[id].vendor) {
    case "microsoft": {
      const tenant = client.tenant;
      if (!tenant || !(tenantId.test(tenant) || (tenant === "consumers" && id !== "sharepoint")))
        fail("workspace_client_not_configured");
      const base = microsoft + tenant + "/oauth2/v2.0/";
      return {
        auth: base + "authorize",
        token: base + "token",
        scopes: workspaceScopes(id),
        pkce: true,
      };
    }
    case "atlassian":
      return {
        auth: "https://auth.atlassian.com/authorize",
        token: "https://auth.atlassian.com/oauth/token",
        scopes: workspaceScopes(id),
        pkce: false,
      };
    case "todoist":
      return {
        auth: "https://app.todoist.com/oauth/authorize",
        token: "https://api.todoist.com/oauth/access_token",
        scopes: workspaceScopes(id),
        pkce: true,
      };
    case "dropbox":
      return {
        auth: "https://www.dropbox.com/oauth2/authorize",
        token: "https://api.dropboxapi.com/oauth2/token",
        scopes: workspaceScopes(id),
        pkce: true,
      };
    case "figma":
      return {
        auth: "https://www.figma.com/oauth",
        token: "https://api.figma.com/v1/oauth/token",
        scopes: workspaceScopes(id),
        pkce: true,
      };
  }
}
function callbackPath(id: CloudId) {
  return `/oauth/${workspaceApps[id].vendor}` as const;
}
export function redirectUri(id: CloudId) {
  return "http://localhost:4870" + callbackPath(id);
}
// A public client identifier can be cached locally. Registration happens on an explicit
// Todoist sign-in only, and never stores a user token or client secret here.
async function registerTodoist(http: Http, signal: AbortSignal): Promise<AppClient> {
  const dir = path.join(lisaHome(), "connectors", "todoist");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "public-client-id");
  return withFileLock(
    file + ".lock",
    async () => {
      try {
        const clientId = (await fs.readFile(file, "utf8")).trim();
        if (!/^tdd_[a-zA-Z0-9_-]{8,240}$/.test(clientId)) fail("workspace_client_not_configured");
        return { clientId };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const response = row(
        await http(
          new URL("https://api.todoist.com/oauth/register"),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              client_name: "LISA read-only",
              redirect_uris: [redirectUri("todoist")],
              scope: "data:read",
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              token_endpoint_auth_method: "none",
            }),
          },
          signal,
        ),
      );
      if (
        typeof response.client_id !== "string" ||
        !/^tdd_[a-zA-Z0-9_-]{8,240}$/.test(response.client_id) ||
        response.token_endpoint_auth_method !== "none" ||
        response.scope !== "data:read" ||
        !Array.isArray(response.redirect_uris) ||
        response.redirect_uris.length !== 1 ||
        response.redirect_uris[0] !== redirectUri("todoist")
      )
        fail("workspace_scope_mismatch");
      await atomicWrite(file, response.client_id);
      return { clientId: response.client_id };
    },
    { signal, staleMs: 60000 },
  );
}
/** The configured client, or undefined when Todoist should register its own public client. */
async function configuredClient(id: CloudId): Promise<AppClient | undefined> {
  try {
    const file = process.env.LISA_WORKSPACE_CLIENTS_FILE;
    if (!file && id === "todoist") return undefined;
    if (!file) fail("workspace_client_not_configured");
    const stat = await fs.stat(file);
    if (
      !stat.isFile() ||
      stat.size > 65536 ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    )
      fail();
    const all = row(JSON.parse(await fs.readFile(file, "utf8"))),
      vendor = workspaceApps[id].vendor;
    if (id === "todoist" && !all[id]) return undefined;
    const config = row(all[id] ?? all[vendor]);
    if (typeof config.clientId !== "string" || !/^[a-zA-Z0-9._-]{3,256}$/.test(config.clientId))
      fail();
    const client: AppClient = { clientId: config.clientId };
    if (vendor === "figma" || vendor === "atlassian" || vendor === "todoist")
      client.clientSecret = identifier(config.clientSecret);
    if (vendor === "microsoft") client.tenant = identifier(config.tenant);
    endpoints(id, client);
    return client;
  } catch {
    fail("workspace_client_not_configured");
  }
}
export async function appClient(id: CloudId, http: Http, signal: AbortSignal): Promise<AppClient> {
  return (await configuredClient(id)) ?? registerTodoist(http, signal);
}
/** Whether a sign-in could start without network access: Todoist always can. */
export async function workspaceClientConfigured(id: CloudId): Promise<boolean> {
  try {
    await configuredClient(id);
    return true;
  } catch {
    return false;
  }
}
export function validLogin(id: CloudId, raw: string) {
  try {
    const u = new URL(raw),
      tenant = u.pathname.split("/")[1];
    const e = endpoints(id, { clientId: "", tenant });
    return (
      raw.length < 8192 &&
      new Set(u.searchParams.keys()).size === u.searchParams.size &&
      u.origin + u.pathname === e.auth &&
      !u.username &&
      !u.password &&
      !u.hash &&
      u.searchParams.get("scope") === e.scopes &&
      u.searchParams.get("redirect_uri") === redirectUri(id) &&
      u.searchParams.get("response_type") === "code" &&
      /^[A-Za-z0-9_-]{43}$/.test(u.searchParams.get("state") ?? "") &&
      (!e.pkce ||
        (u.searchParams.get("code_challenge_method") === "S256" &&
          /^[A-Za-z0-9_-]{43}$/.test(u.searchParams.get("code_challenge") ?? "")))
    );
  } catch {
    return false;
  }
}
function checkScopes(id: CloudId, raw: unknown, requested: string, refresh: boolean) {
  // Figma and legacy Todoist omit scope; Dropbox refresh may omit an unchanged scope.
  if (raw === undefined && (id === "figma" || id === "todoist" || (refresh && id === "dropbox")))
    return;
  if (typeof raw !== "string") fail("workspace_scope_mismatch");
  const normalize = (s: string) =>
    s
      .split(/[ ,]+/)
      .filter(Boolean)
      .map((x) => x.replace(/^https:\/\/graph\.microsoft\.com\//i, "").toLowerCase());
  const microsoft = workspaceApps[id].vendor === "microsoft";
  // Microsoft adds OpenID scopes and returns everything already consented to the same app
  // registration, so a token for one Microsoft source can list another source's read scope.
  // Anything outside the Microsoft workspace read scopes still fails closed.
  const ignored = new Set(
    microsoft ? ["offline_access", "openid", "profile", "email"] : ["offline_access"],
  );
  const tolerated = new Set(
    microsoft
      ? workspaceIds.flatMap((other) =>
          workspaceApps[other].vendor === "microsoft" ? normalize(workspaceScopes(other)) : [],
        )
      : [],
  );
  const required = normalize(requested).filter((x) => !ignored.has(x));
  const granted = normalize(raw);
  if (
    required.some((s) => !granted.includes(s)) ||
    granted.some((s) => !required.includes(s) && !ignored.has(s) && !tolerated.has(s))
  )
    fail("workspace_scope_mismatch");
}
async function exchange(
  id: CloudId,
  client: AppClient,
  fields: Record<string, string>,
  http: Http,
  signal: AbortSignal,
  previous?: Grant,
): Promise<Grant> {
  const vendor = workspaceApps[id].vendor,
    e = endpoints(id, client);
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  let endpoint = e.token;
  if (vendor === "figma") {
    headers.Authorization =
      "Basic " + Buffer.from(client.clientId + ":" + client.clientSecret).toString("base64");
    if (previous) endpoint = "https://api.figma.com/v1/oauth/refresh";
  } else {
    fields.client_id = client.clientId;
    if (client.clientSecret) fields.client_secret = client.clientSecret;
  }
  if (vendor === "microsoft") fields.scope = e.scopes;
  if (vendor === "atlassian") headers["Content-Type"] = "application/json";
  const result = row(
    await http(
      new URL(endpoint),
      {
        method: "POST",
        headers,
        body:
          vendor === "atlassian" ? JSON.stringify(fields) : new URLSearchParams(fields).toString(),
      },
      signal,
    ),
  );
  checkScopes(id, result.scope, e.scopes, !!previous);
  if (result.token_type !== undefined && String(result.token_type).toLowerCase() !== "bearer")
    fail();
  const seconds = result.expires_in;
  if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds <= 0) fail();
  const token = (v: unknown) =>
    typeof v === "string" && v.length > 0 && v.length < 32000 ? v : fail();
  return {
    provider: id,
    client,
    access: token(result.access_token),
    refresh: result.refresh_token ? token(result.refresh_token) : previous?.refresh,
    expires: Date.now() + seconds * 1000,
    subject: previous?.subject,
  };
}
export async function authorizeCloud(
  id: CloudId,
  client: AppClient,
  http: Http,
  signal: AbortSignal,
  progress: (v: { authorizationUrl: string }) => void,
) {
  const e = endpoints(id, client);
  return loopbackAuthorization(
    signal,
    null,
    async (attempt) => {
      const u = new URL(e.auth);
      u.search = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: attempt.redirect,
        response_type: "code",
        state: attempt.state,
        scope: e.scopes,
      }).toString();
      if (e.pkce) {
        u.searchParams.set("code_challenge_method", "S256");
        u.searchParams.set("code_challenge", attempt.challenge);
      }
      if (workspaceApps[id].vendor === "atlassian") {
        u.searchParams.set("audience", "api.atlassian.com");
        u.searchParams.set("prompt", "consent");
      }
      if (id === "dropbox") u.searchParams.set("token_access_type", "offline");
      progress({ authorizationUrl: u.href });
      const fields: Record<string, string> = {
        code: await attempt.code,
        redirect_uri: attempt.redirect,
        grant_type: "authorization_code",
      };
      if (e.pkce) fields.code_verifier = attempt.verifier;
      return exchange(id, client, fields, http, signal);
    },
    { hostname: "localhost", port: 4870, pathname: callbackPath(id) },
  );
}
export async function refreshCloud(g: Grant, http: Http, signal: AbortSignal) {
  if (!g.refresh) fail("workspace_reauthorize");
  return exchange(
    g.provider,
    g.client,
    { grant_type: "refresh_token", refresh_token: g.refresh },
    http,
    signal,
    g,
  );
}
