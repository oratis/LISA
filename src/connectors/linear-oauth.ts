import { ConnectorError } from "./types.js";
import { loopbackAuthorization } from "./oauth-loopback.js";
import { remoteJson, type McpFetch } from "../mcp/http.js";
export const LINEAR_ORIGIN = "https://mcp.linear.app";
export const LINEAR_ENDPOINT = LINEAR_ORIGIN + "/mcp/readonly";
export const linearEndpointAllowed = (url: URL, method: string) =>
  url.origin === LINEAR_ORIGIN &&
  !url.search &&
  ((method === "GET" &&
    [
      "/.well-known/oauth-protected-resource/mcp/readonly",
      "/.well-known/oauth-authorization-server",
    ].includes(url.pathname)) ||
    (method === "POST" && ["/register", "/token", "/mcp/readonly"].includes(url.pathname)));
export interface LinearCredential {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiry: number;
  scope: "read";
}
const text = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 16000;
export function parseLinearCredential(raw: string): LinearCredential {
  try {
    const c = JSON.parse(raw) as LinearCredential;
    if (
      !c ||
      !text(c.clientId) ||
      !text(c.accessToken) ||
      !text(c.refreshToken) ||
      !Number.isFinite(c.expiry) ||
      c.scope !== "read"
    )
      throw new Error();
    return c;
  } catch {
    throw new ConnectorError("linear_reauthorization_required");
  }
}
function token(
  data: Record<string, unknown>,
  clientId: string,
  previous?: LinearCredential,
): LinearCredential {
  // RFC 6749 allows omission when scope is identical to the requested scope.
  const scopes =
    data.scope === undefined
      ? ["read"]
      : typeof data.scope === "string"
        ? data.scope.split(/\s+/)
        : data.scope;
  if (!Array.isArray(scopes) || scopes.length !== 1 || scopes[0] !== "read")
    throw new ConnectorError("linear_read_scope_required");
  const refreshToken = data.refresh_token ?? previous?.refreshToken;
  if (
    !text(data.access_token) ||
    !text(refreshToken) ||
    typeof data.expires_in !== "number" ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0 ||
    data.expires_in > 31 * 86400 ||
    typeof data.token_type !== "string" ||
    data.token_type.toLowerCase() !== "bearer"
  )
    throw new ConnectorError("mcp_invalid_response");
  return {
    clientId,
    accessToken: data.access_token,
    refreshToken,
    expiry: Date.now() + data.expires_in * 1000,
    scope: "read",
  };
}
export async function authorizeLinear(
  fetcher: McpFetch,
  signal: AbortSignal,
  progress: (v: { authorizationUrl: string }) => void,
): Promise<LinearCredential> {
  const resource = await remoteJson(
    fetcher,
    LINEAR_ORIGIN + "/.well-known/oauth-protected-resource/mcp/readonly",
  );
  if (
    resource.resource !== LINEAR_ENDPOINT ||
    !Array.isArray(resource.authorization_servers) ||
    !resource.authorization_servers.includes(LINEAR_ORIGIN) ||
    !Array.isArray(resource.scopes_supported) ||
    !resource.scopes_supported.includes("read")
  )
    throw new ConnectorError("mcp_metadata_mismatch");
  const auth = await remoteJson(fetcher, LINEAR_ORIGIN + "/.well-known/oauth-authorization-server");
  if (
    auth.issuer !== LINEAR_ORIGIN ||
    auth.authorization_endpoint !== LINEAR_ORIGIN + "/authorize" ||
    auth.token_endpoint !== LINEAR_ORIGIN + "/token" ||
    auth.registration_endpoint !== LINEAR_ORIGIN + "/register" ||
    !Array.isArray(auth.code_challenge_methods_supported) ||
    !auth.code_challenge_methods_supported.includes("S256") ||
    auth.authorization_response_iss_parameter_supported !== true
  )
    throw new ConnectorError("mcp_metadata_mismatch");
  return loopbackAuthorization(signal, LINEAR_ORIGIN, async (a) => {
    const registration = await remoteJson(fetcher, LINEAR_ORIGIN + "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "LISA read-only",
        redirect_uris: [a.redirect],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: "read",
      }),
    });
    if (
      !text(registration.client_id) ||
      registration.token_endpoint_auth_method !== "none" ||
      !Array.isArray(registration.redirect_uris) ||
      !registration.redirect_uris.includes(a.redirect)
    )
      throw new ConnectorError("mcp_registration_failed");
    const clientId = registration.client_id;
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: a.redirect,
      response_type: "code",
      scope: "read",
      state: a.state,
      code_challenge: a.challenge,
      code_challenge_method: "S256",
      resource: LINEAR_ENDPOINT,
      prompt: "consent",
    });
    progress({ authorizationUrl: LINEAR_ORIGIN + "/authorize?" + query });
    const code = await a.code;
    signal.throwIfAborted();
    return token(
      await remoteJson(fetcher, LINEAR_ORIGIN + "/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          redirect_uri: a.redirect,
          grant_type: "authorization_code",
          code,
          code_verifier: a.verifier,
          resource: LINEAR_ENDPOINT,
        }).toString(),
      }),
      clientId,
    );
  });
}
export async function refreshLinear(
  c: LinearCredential,
  fetcher: McpFetch,
): Promise<LinearCredential> {
  return token(
    await remoteJson(fetcher, LINEAR_ORIGIN + "/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: c.clientId,
        grant_type: "refresh_token",
        refresh_token: c.refreshToken,
        resource: LINEAR_ENDPOINT,
      }).toString(),
    }),
    c.clientId,
    c,
  );
}
