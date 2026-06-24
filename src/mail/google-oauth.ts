/**
 * Google OAuth2 for Gmail (read-only) — no SDK, just fetch + the documented
 * token endpoints. Used by the loopback "installed app" flow (CLI) and by the
 * Gmail connector's token refresh.
 *
 * Setup the user does once: create an OAuth client (type "Desktop app") in a
 * Google Cloud project, enable the Gmail API, and provide the client id/secret
 * (LISA_GOOGLE_CLIENT_ID / _SECRET, or --client-id/--client-secret). Tokens are
 * stored per-account in the 0600 secrets file; only the gmail.readonly scope is
 * requested.
 */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface GoogleTokens {
  accessToken: string;
  /** Present on the initial exchange (access_type=offline); absent on refresh. */
  refreshToken?: string;
  /** Absolute expiry, epoch ms. */
  expiry: number;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Build the consent URL. Pure. */
export function buildAuthUrl(o: { clientId: string; redirectUri: string; state: string }): string {
  const q = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPE,
    access_type: "offline",
    prompt: "consent", // force a refresh_token even on re-auth
    state: o.state,
  });
  return `${AUTH_BASE}?${q.toString()}`;
}

/** True if the access token is expired (60s skew). Pure. */
export function tokenExpired(expiry: number, now: number): boolean {
  return now >= expiry - 60_000;
}

function parseTokens(json: Record<string, unknown>, now: number): GoogleTokens {
  const accessToken = String(json.access_token ?? "");
  if (!accessToken) throw new Error("no access_token in token response");
  const ttl = typeof json.expires_in === "number" ? json.expires_in : 3600;
  return {
    accessToken,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
    expiry: now + ttl * 1000,
  };
}

async function postToken(body: URLSearchParams, fetchImpl: FetchLike, now: number): Promise<GoogleTokens> {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`google token endpoint ${res.status}: ${text.slice(0, 200)}`);
  return parseTokens(JSON.parse(text) as Record<string, unknown>, now);
}

/** Exchange an auth code for tokens. */
export async function exchangeCode(
  o: { code: string; clientId: string; clientSecret: string; redirectUri: string },
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  now: number = Date.now(),
): Promise<GoogleTokens> {
  return postToken(
    new URLSearchParams({
      code: o.code,
      client_id: o.clientId,
      client_secret: o.clientSecret,
      redirect_uri: o.redirectUri,
      grant_type: "authorization_code",
    }),
    fetchImpl,
    now,
  );
}

/** Refresh an access token (refresh_token is reused, not returned). */
export async function refreshAccessToken(
  o: { refreshToken: string; clientId: string; clientSecret: string },
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  now: number = Date.now(),
): Promise<GoogleTokens> {
  const t = await postToken(
    new URLSearchParams({
      refresh_token: o.refreshToken,
      client_id: o.clientId,
      client_secret: o.clientSecret,
      grant_type: "refresh_token",
    }),
    fetchImpl,
    now,
  );
  return { ...t, refreshToken: t.refreshToken ?? o.refreshToken };
}
