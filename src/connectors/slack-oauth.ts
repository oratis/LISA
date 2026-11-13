import fs from "node:fs/promises";
import { ConnectorError } from "./types.js";
import { loopbackAuthorization } from "./oauth-loopback.js";
import {
  assertSlackScopes,
  SLACK_READ_SCOPES,
  SLACK_ORIGIN,
  type SlackHttp,
} from "./slack-http.js";

export const slackId = (v: unknown, prefix: string): v is string =>
  typeof v === "string" && new RegExp("^[" + prefix + "][A-Z0-9]{2,40}$").test(v);
const secret = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 16000;
export interface SlackClient {
  clientId: string;
  appId: string;
  redirectUri: string;
}
export interface SlackCredential extends SlackClient {
  accessToken: string;
  refreshToken?: string;
  expiry?: number;
  scopes: string[];
  userId: string;
  workspaceId: string;
}
function validClient(c: SlackClient) {
  try {
    const u = new URL(c.redirectUri);
    return (
      /^\d{2,30}\.\d{2,30}$/.test(c.clientId) &&
      slackId(c.appId, "A") &&
      u.protocol === "http:" &&
      u.hostname === "localhost" &&
      !!u.port &&
      Number(u.port) >= 1024 &&
      u.pathname === "/oauth/slack" &&
      !u.search &&
      !u.hash &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}
export async function slackClient(): Promise<SlackClient> {
  try {
    let c: SlackClient;
    const file = process.env.LISA_SLACK_CLIENT_FILE;
    if (file) {
      if ((await fs.stat(file)).size > 32000) throw new Error();
      c = JSON.parse(await fs.readFile(file, "utf8")) as SlackClient;
    } else
      c = {
        clientId: process.env.LISA_SLACK_CLIENT_ID ?? "",
        appId: process.env.LISA_SLACK_APP_ID ?? "",
        redirectUri: process.env.LISA_SLACK_REDIRECT_URI ?? "http://localhost:4861/oauth/slack",
      };
    if (!validClient(c)) throw new Error();
    return { clientId: c.clientId, appId: c.appId, redirectUri: c.redirectUri };
  } catch {
    throw new ConnectorError("slack_client_not_configured");
  }
}
function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new ConnectorError("slack_invalid_response");
  return v as Record<string, unknown>;
}
/** Initial user grant is nested; a rotated user token is returned at the top level. */
function token(
  r: Record<string, unknown>,
  client: SlackClient,
  previous?: SlackCredential,
): SlackCredential {
  const u = r.authed_user ? record(r.authed_user) : r;
  const scopes = typeof u.scope === "string" ? u.scope.split(/[ ,]+/).filter(Boolean) : [];
  assertSlackScopes(scopes, !!previous);
  if (
    !secret(u.access_token) ||
    u.token_type !== "user" ||
    r.is_enterprise_install === true ||
    (r.app_id !== undefined && r.app_id !== client.appId) ||
    (!previous && r.app_id !== client.appId) ||
    (r.authed_user && (r.access_token || r.bot_user_id || r.scope))
  )
    throw new ConnectorError("slack_invalid_response");
  const userId = u.id ?? u.user_id ?? previous?.userId;
  const workspaceId = r.team ? record(r.team).id : previous?.workspaceId;
  if (!slackId(userId, "UW") || !slackId(workspaceId, "T"))
    throw new ConnectorError("slack_invalid_response");
  if (previous && (userId !== previous.userId || workspaceId !== previous.workspaceId))
    throw new ConnectorError("connector_account_changed");
  const rotating = u.expires_in !== undefined || u.refresh_token !== undefined;
  if (
    rotating &&
    (!secret(u.refresh_token) ||
      typeof u.expires_in !== "number" ||
      !Number.isInteger(u.expires_in) ||
      u.expires_in <= 0 ||
      u.expires_in > 86400)
  )
    throw new ConnectorError("slack_invalid_response");
  if (previous?.refreshToken && !rotating) throw new ConnectorError("slack_invalid_response");
  return {
    ...client,
    accessToken: u.access_token,
    userId,
    workspaceId,
    scopes: scopes.filter((scope) => scope !== "identify"),
    ...(rotating
      ? {
          refreshToken: u.refresh_token as string,
          expiry: Date.now() + (u.expires_in as number) * 1000,
        }
      : {}),
  };
}
export function parseSlackCredential(raw: string): SlackCredential {
  try {
    const c = JSON.parse(raw) as SlackCredential;
    if (
      !validClient(c) ||
      !secret(c.accessToken) ||
      !slackId(c.userId, "UW") ||
      !slackId(c.workspaceId, "T") ||
      (c.refreshToken !== undefined && (!secret(c.refreshToken) || !Number.isFinite(c.expiry))) ||
      (c.expiry !== undefined && (!secret(c.refreshToken) || !Number.isFinite(c.expiry)))
    )
      throw new Error();
    assertSlackScopes(c.scopes);
    return c;
  } catch {
    throw new ConnectorError("slack_reauthorization_required");
  }
}
export async function authorizeSlack(
  client: SlackClient,
  http: SlackHttp,
  signal: AbortSignal,
  progress: (v: { authorizationUrl: string }) => void,
): Promise<SlackCredential> {
  if (!validClient(client)) throw new ConnectorError("slack_client_not_configured");
  return loopbackAuthorization(
    signal,
    null,
    async (a) => {
      if (a.redirect !== client.redirectUri) throw new ConnectorError("slack_invalid_redirect");
      progress({
        authorizationUrl:
          SLACK_ORIGIN +
          "/oauth/v2/authorize?" +
          new URLSearchParams({
            client_id: client.clientId,
            scope: "",
            user_scope: SLACK_READ_SCOPES.join(","),
            redirect_uri: a.redirect,
            state: a.state,
            code_challenge: a.challenge,
            code_challenge_method: "S256",
          }),
      });
      const code = await a.code;
      signal.throwIfAborted();
      return token(
        (
          await http("oauth.v2.access", signal, {
            form: {
              client_id: client.clientId,
              grant_type: "authorization_code",
              code,
              redirect_uri: a.redirect,
              code_verifier: a.verifier,
            },
          })
        ).data,
        client,
      );
    },
    {
      hostname: "localhost",
      port: Number(new URL(client.redirectUri).port),
      pathname: "/oauth/slack",
      portInUseCode: "slack_callback_port_in_use",
    },
  );
}
export async function refreshSlack(c: SlackCredential, http: SlackHttp, signal: AbortSignal) {
  if (!c.refreshToken) throw new ConnectorError("slack_reauthorization_required");
  return token(
    (
      await http("oauth.v2.access", signal, {
        form: { client_id: c.clientId, grant_type: "refresh_token", refresh_token: c.refreshToken },
      })
    ).data,
    c,
    c,
  );
}
