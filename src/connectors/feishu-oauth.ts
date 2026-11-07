import fs from "node:fs/promises";
import { ConnectorError } from "./types.js";
import { loopbackAuthorization } from "./oauth-loopback.js";
import {
  FEISHU_ACCOUNTS,
  FEISHU_SCOPES,
  assertFeishuScopes,
  type FeishuHttp,
} from "./feishu-http.js";
export interface FeishuClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}
export interface FeishuCredential extends FeishuClient {
  accessToken: string;
  refreshToken: string;
  expiry: number;
  refreshExpiry: number;
  scopes: string[];
  userId?: string;
  tenantId?: string;
}
const secret = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 16000;
export const feishuIdentityId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{3,100}$/.test(v);
function validClient(c: FeishuClient) {
  try {
    const u = new URL(c.redirectUri);
    return (
      /^cli_[A-Za-z0-9]{8,64}$/.test(c.clientId) &&
      secret(c.clientSecret) &&
      u.protocol === "http:" &&
      u.hostname === "localhost" &&
      Number(u.port) >= 1024 &&
      u.pathname === "/oauth/feishu" &&
      !u.search &&
      !u.hash &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}
export async function feishuClient(): Promise<FeishuClient> {
  try {
    let c: FeishuClient;
    const file = process.env.LISA_FEISHU_CLIENT_FILE;
    if (file) {
      if ((await fs.stat(file)).size > 32000) throw Error();
      c = JSON.parse(await fs.readFile(file, "utf8")) as FeishuClient;
    } else
      c = {
        clientId: process.env.LISA_FEISHU_CLIENT_ID ?? "",
        clientSecret: process.env.LISA_FEISHU_CLIENT_SECRET ?? "",
        redirectUri: process.env.LISA_FEISHU_REDIRECT_URI ?? "http://localhost:4863/oauth/feishu",
      };
    if (!validClient(c)) throw Error();
    return { clientId: c.clientId, clientSecret: c.clientSecret, redirectUri: c.redirectUri };
  } catch {
    throw new ConnectorError("feishu_client_not_configured");
  }
}
function token(
  r: Record<string, unknown>,
  client: FeishuClient,
  previous?: FeishuCredential,
): FeishuCredential {
  const scopes = typeof r.scope === "string" ? r.scope.trim().split(/\s+/) : [];
  assertFeishuScopes(scopes);
  if (
    !secret(r.access_token) ||
    !secret(r.refresh_token) ||
    r.token_type !== "Bearer" ||
    typeof r.expires_in !== "number" ||
    !Number.isInteger(r.expires_in) ||
    r.expires_in <= 0 ||
    r.expires_in > 86400 ||
    typeof r.refresh_token_expires_in !== "number" ||
    !Number.isInteger(r.refresh_token_expires_in) ||
    r.refresh_token_expires_in <= 0 ||
    r.refresh_token_expires_in > 366 * 86400
  )
    throw new ConnectorError("feishu_invalid_response");
  return {
    ...client,
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    expiry: Date.now() + r.expires_in * 1000,
    refreshExpiry: Date.now() + r.refresh_token_expires_in * 1000,
    scopes,
    ...(previous?.userId ? { userId: previous.userId, tenantId: previous.tenantId } : {}),
  };
}
export function parseFeishuCredential(raw: string): FeishuCredential {
  try {
    const c = JSON.parse(raw) as FeishuCredential;
    if (
      !validClient(c) ||
      !secret(c.accessToken) ||
      !secret(c.refreshToken) ||
      !Number.isFinite(c.expiry) ||
      !Number.isFinite(c.refreshExpiry) ||
      !feishuIdentityId(c.userId) ||
      !feishuIdentityId(c.tenantId)
    )
      throw Error();
    assertFeishuScopes(c.scopes);
    return c;
  } catch {
    throw new ConnectorError("feishu_reauthorization_required");
  }
}
export async function authorizeFeishu(
  client: FeishuClient,
  http: FeishuHttp,
  signal: AbortSignal,
  progress: (v: { authorizationUrl: string }) => void,
) {
  if (!validClient(client)) throw new ConnectorError("feishu_client_not_configured");
  return loopbackAuthorization(
    signal,
    null,
    async (a) => {
      if (a.redirect !== client.redirectUri) throw new ConnectorError("feishu_invalid_redirect");
      const scope = FEISHU_SCOPES.join(" ");
      progress({
        authorizationUrl:
          FEISHU_ACCOUNTS +
          "/open-apis/authen/v1/authorize?" +
          new URLSearchParams({
            client_id: client.clientId,
            response_type: "code",
            redirect_uri: a.redirect,
            scope,
            state: a.state,
            code_challenge: a.challenge,
            code_challenge_method: "S256",
            prompt: "consent",
          }),
      });
      const code = await a.code;
      signal.throwIfAborted();
      return token(
        await http(FEISHU_ACCOUNTS + "/oauth/v3/token", signal, {
          form: {
            grant_type: "authorization_code",
            client_id: client.clientId,
            client_secret: client.clientSecret,
            code,
            redirect_uri: a.redirect,
            code_verifier: a.verifier,
            scope,
          },
        }),
        client,
      );
    },
    {
      hostname: "localhost",
      port: Number(new URL(client.redirectUri).port),
      pathname: "/oauth/feishu",
      portInUseCode: "feishu_callback_port_in_use",
    },
  );
}
export async function refreshFeishu(c: FeishuCredential, http: FeishuHttp, signal: AbortSignal) {
  if (c.refreshExpiry <= Date.now()) throw new ConnectorError("feishu_reauthorization_required");
  return token(
    await http(FEISHU_ACCOUNTS + "/oauth/v3/token", signal, {
      form: {
        grant_type: "refresh_token",
        client_id: c.clientId,
        client_secret: c.clientSecret,
        refresh_token: c.refreshToken,
        scope: FEISHU_SCOPES.join(" "),
      },
    }),
    c,
    c,
  );
}

/** Revoke refresh and access separately; Feishu does not invalidate access when refresh is revoked. */
export async function revokeFeishu(c: FeishuCredential, http: FeishuHttp, signal: AbortSignal) {
  const results = await Promise.allSettled(
    (["refresh_token", "access_token"] as const).map((hint) =>
      http(FEISHU_ACCOUNTS + "/oauth/v1/revoke", signal, {
        form: {
          client_id: c.clientId,
          client_secret: c.clientSecret,
          token_type_hint: hint,
          token: hint === "refresh_token" ? c.refreshToken : c.accessToken,
        },
      }),
    ),
  );
  if (results.some((r) => r.status === "rejected"))
    throw new ConnectorError("feishu_request_failed");
}
