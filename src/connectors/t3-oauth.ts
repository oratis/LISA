import { ConnectorError } from "./types.js";
import { loopbackAuthorization } from "./oauth-loopback.js";
import { remoteFetch, remoteJson, type McpFetch } from "../mcp/http.js";

export const T3_SCOPE = "orchestration:read";
export function t3Endpoint(raw = process.env.LISA_T3_MCP_URL) {
  try {
    if (!raw || raw.length > 2048) throw new Error();
    const url = new URL(raw);
    const local =
      url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (!local && (url.protocol !== "https:" || url.port)) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      url.pathname !== "/mcp"
    )
      throw new Error();
    return url.href;
  } catch {
    throw new ConnectorError("t3_endpoint_not_configured");
  }
}
export function t3Fetch(endpoint: string, signal: AbortSignal): McpFetch {
  const origin = new URL(t3Endpoint(endpoint)).origin;
  return remoteFetch(
    (url, method) =>
      url.origin === origin &&
      !url.search &&
      ((method === "GET" &&
        [
          "/.well-known/t3/environment",
          "/api/auth/session",
          "/.well-known/oauth-protected-resource/mcp",
          "/.well-known/oauth-authorization-server",
        ].includes(url.pathname)) ||
        (method === "POST" &&
          ["/oauth/mcp/register", "/oauth/mcp/token", "/mcp"].includes(url.pathname)) ||
        (method === "DELETE" && url.pathname === "/mcp")),
    signal,
    undefined,
    "t3_reauthorization_required",
    origin,
  );
}
export interface T3Credential {
  endpoint: string;
  clientId: string;
  accessToken: string;
  expiry: number;
  scope: typeof T3_SCOPE;
  environmentId?: string;
}
const text = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 16000;
export function parseT3Credential(raw: string): T3Credential {
  try {
    const c = JSON.parse(raw) as T3Credential;
    if (
      !c ||
      t3Endpoint(c.endpoint) !== c.endpoint ||
      !text(c.clientId) ||
      !text(c.accessToken) ||
      !Number.isFinite(c.expiry) ||
      c.scope !== T3_SCOPE ||
      (c.environmentId !== undefined && !text(c.environmentId))
    )
      throw new Error();
    return c;
  } catch {
    throw new ConnectorError("t3_reauthorization_required");
  }
}

/** Reviewed against T3 e89abada: authorization-code + PKCE, no refresh/revoke
 * endpoint. The user must choose Read only; wider returned scopes are rejected. */
export async function authorizeT3(
  endpoint: string,
  fetcher: McpFetch,
  signal: AbortSignal,
  progress: (v: { authorizationUrl: string }) => void,
): Promise<T3Credential> {
  const origin = new URL(t3Endpoint(endpoint)).origin;
  const resource = await remoteJson(fetcher, origin + "/.well-known/oauth-protected-resource/mcp");
  const auth = await remoteJson(fetcher, origin + "/.well-known/oauth-authorization-server");
  if (
    resource.resource !== endpoint ||
    !Array.isArray(resource.authorization_servers) ||
    !resource.authorization_servers.includes(origin) ||
    !Array.isArray(resource.scopes_supported) ||
    !resource.scopes_supported.includes(T3_SCOPE) ||
    auth.issuer !== origin ||
    auth.authorization_endpoint !== origin + "/oauth/mcp/authorize" ||
    auth.token_endpoint !== origin + "/oauth/mcp/token" ||
    auth.registration_endpoint !== origin + "/oauth/mcp/register" ||
    !Array.isArray(auth.code_challenge_methods_supported) ||
    !auth.code_challenge_methods_supported.includes("S256") ||
    auth.authorization_response_iss_parameter_supported !== true
  )
    throw new ConnectorError("mcp_metadata_mismatch");
  return loopbackAuthorization(signal, origin, async (attempt) => {
    const registration = await remoteJson(fetcher, origin + "/oauth/mcp/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "LISA — selected project lists (read only)",
        redirect_uris: [attempt.redirect],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    if (
      !text(registration.client_id) ||
      registration.token_endpoint_auth_method !== "none" ||
      !Array.isArray(registration.redirect_uris) ||
      !registration.redirect_uris.includes(attempt.redirect)
    )
      throw new ConnectorError("mcp_registration_failed");
    const query = new URLSearchParams({
      client_id: registration.client_id,
      redirect_uri: attempt.redirect,
      response_type: "code",
      state: attempt.state,
      code_challenge: attempt.challenge,
      code_challenge_method: "S256",
      resource: endpoint,
      scope: T3_SCOPE,
    });
    progress({ authorizationUrl: origin + "/oauth/mcp/authorize?" + query });
    const code = await attempt.code;
    signal.throwIfAborted();
    const token = await remoteJson(fetcher, origin + "/oauth/mcp/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: registration.client_id,
        redirect_uri: attempt.redirect,
        grant_type: "authorization_code",
        code,
        code_verifier: attempt.verifier,
        resource: endpoint,
      }).toString(),
    });
    if (token.scope !== T3_SCOPE) throw new ConnectorError("t3_read_scope_required");
    if (
      !text(token.access_token) ||
      typeof token.token_type !== "string" ||
      token.token_type.toLowerCase() !== "bearer" ||
      typeof token.expires_in !== "number" ||
      !Number.isFinite(token.expires_in) ||
      token.expires_in <= 0 ||
      token.expires_in > 31 * 86400
    )
      throw new ConnectorError("mcp_invalid_response");
    signal.throwIfAborted();
    return {
      endpoint,
      clientId: registration.client_id,
      accessToken: token.access_token,
      expiry: Date.now() + token.expires_in * 1000,
      scope: T3_SCOPE,
    };
  });
}
