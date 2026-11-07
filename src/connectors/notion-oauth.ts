import fs from "node:fs/promises";
import { ConnectorError } from "./types.js";
import { loopbackAuthorization } from "./oauth-loopback.js";
import { NOTION_ORIGIN, type NotionHttp } from "./notion-http.js";
export const notionId = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const text = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 16000;
export interface NotionClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}
export interface NotionCredential extends NotionClient {
  accessToken: string;
  refreshToken: string;
  workspaceId: string;
  workspaceName: string;
  botId: string;
  identityId?: string;
}
export async function notionClient(): Promise<NotionClient> {
  let raw: unknown;
  try {
    const file = process.env.LISA_NOTION_CLIENT_FILE;
    if (file) {
      if ((await fs.stat(file)).size > 32000) throw new Error();
      raw = JSON.parse(await fs.readFile(file, "utf8"));
    } else
      raw = {
        clientId: process.env.LISA_NOTION_CLIENT_ID,
        clientSecret: process.env.LISA_NOTION_CLIENT_SECRET,
        redirectUri: process.env.LISA_NOTION_REDIRECT_URI ?? "http://localhost:4860/oauth/notion",
      };
    const c = raw as NotionClient,
      u = new URL(c.redirectUri);
    if (
      !notionId(c.clientId) ||
      !text(c.clientSecret) ||
      u.protocol !== "http:" ||
      !["localhost", "127.0.0.1"].includes(u.hostname) ||
      !u.port ||
      Number(u.port) < 1024 ||
      u.pathname !== "/oauth/notion" ||
      u.search ||
      u.hash ||
      u.username ||
      u.password
    )
      throw new Error();
    return c;
  } catch {
    throw new ConnectorError("notion_client_not_configured");
  }
}
function token(
  r: Record<string, unknown>,
  client: NotionClient,
  previous?: NotionCredential,
): NotionCredential {
  if (
    !text(r.access_token) ||
    !text(r.refresh_token) ||
    !notionId(r.workspace_id) ||
    !notionId(r.bot_id) ||
    typeof r.token_type !== "string" ||
    r.token_type.toLowerCase() !== "bearer"
  )
    throw new ConnectorError("notion_invalid_response");
  if (previous && (r.workspace_id !== previous.workspaceId || r.bot_id !== previous.botId))
    throw new ConnectorError("connector_account_changed");
  return {
    ...client,
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    workspaceId: r.workspace_id,
    workspaceName: typeof r.workspace_name === "string" ? r.workspace_name.slice(0, 400) : "Notion",
    botId: r.bot_id,
    ...(previous?.identityId ? { identityId: previous.identityId } : {}),
  };
}
export function parseNotionCredential(raw: string): NotionCredential {
  try {
    const c = JSON.parse(raw) as NotionCredential;
    if (
      !c ||
      !notionId(c.clientId) ||
      !text(c.clientSecret) ||
      !text(c.accessToken) ||
      !text(c.refreshToken) ||
      !notionId(c.workspaceId) ||
      !notionId(c.botId) ||
      !notionId(c.identityId) ||
      typeof c.workspaceName !== "string" ||
      c.workspaceName.length > 400
    )
      throw new Error();
    return c;
  } catch {
    throw new ConnectorError("notion_reauthorization_required");
  }
}
export async function assertNotionReadScope(
  c: NotionCredential,
  http: NotionHttp,
  signal: AbortSignal,
) {
  const r = await http("/v1/oauth/introspect", signal, {
    basic: c,
    json: { token: c.accessToken },
  });
  if (r.active !== true) throw new ConnectorError("notion_reauthorization_required");
  // Unknown capabilities never acquire access by being described as harmless by a tool.
  const scopes = typeof r.scope === "string" ? r.scope.trim().split(/\s+/) : [];
  if (scopes.length !== 1 || scopes[0] !== "read_content")
    throw new ConnectorError("notion_read_scope_required");
}
export async function authorizeNotion(
  client: NotionClient,
  http: NotionHttp,
  signal: AbortSignal,
  progress: (v: { authorizationUrl: string }) => void,
): Promise<NotionCredential> {
  const redirect = new URL(client.redirectUri);
  // Notion documents confidential-client OAuth, without PKCE or response issuer.
  // The pre-registered loopback URL, state and fixed token endpoint bind this flow.
  return loopbackAuthorization(
    signal,
    null,
    async (a) => {
      if (a.redirect !== client.redirectUri) throw new ConnectorError("notion_invalid_redirect");
      const params = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: a.redirect,
        response_type: "code",
        owner: "user",
        state: a.state,
      });
      progress({ authorizationUrl: NOTION_ORIGIN + "/v1/oauth/authorize?" + params });
      const code = await a.code;
      signal.throwIfAborted();
      return token(
        await http("/v1/oauth/token", signal, {
          basic: client,
          json: { grant_type: "authorization_code", code, redirect_uri: a.redirect },
        }),
        client,
      );
    },
    {
      port: Number(redirect.port),
      hostname: redirect.hostname as "localhost" | "127.0.0.1",
      pathname: "/oauth/notion",
    },
  );
}
export async function refreshNotion(c: NotionCredential, http: NotionHttp, signal: AbortSignal) {
  return token(
    await http("/v1/oauth/token", signal, {
      basic: c,
      json: { grant_type: "refresh_token", refresh_token: c.refreshToken },
    }),
    c,
    c,
  );
}
