/** Sign in with Apple authorization-code exchange and account-deletion revocation. */
import crypto from "node:crypto";

export interface AppleAuthorizationConfig {
  teamId: string;
  keyId: string;
  privateKey: string;
}

export function appleAuthorizationConfig(
  env: NodeJS.ProcessEnv = process.env,
): AppleAuthorizationConfig | null {
  const teamId = env.LISA_APPLE_TEAM_ID?.trim();
  const keyId = env.LISA_APPLE_KEY_ID?.trim();
  const privateKey = env.LISA_APPLE_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  if (!teamId || !keyId || !privateKey) return null;
  return { teamId, keyId, privateKey };
}

export class AppleAuthorizationError extends Error {
  constructor(public readonly code: "apple_authorization_failed" | "apple_revocation_failed") {
    super(code);
  }
}

export function appleClientSecret(
  config: AppleAuthorizationConfig,
  clientId: string,
  now = Date.now(),
): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const iat = Math.floor(now / 1000);
  const input = `${encode({ alg: "ES256", kid: config.keyId })}.${encode({
    iss: config.teamId,
    sub: clientId,
    aud: "https://appleid.apple.com",
    iat,
    exp: iat + 300,
  })}`;
  const signature = crypto.sign("sha256", Buffer.from(input), {
    key: config.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${input}.${signature.toString("base64url")}`;
}

type AppleFetch = typeof fetch;

export async function exchangeAppleAuthorizationCode(
  config: AppleAuthorizationConfig,
  clientId: string,
  code: string,
  options: { fetch?: AppleFetch; redirectUri?: string } = {},
): Promise<{ refreshToken: string; identityToken: string }> {
  try {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: appleClientSecret(config, clientId),
      code,
      grant_type: "authorization_code",
    });
    if (options.redirectUri) body.set("redirect_uri", options.redirectUri);
    const response = await (options.fetch ?? fetch)("https://appleid.apple.com/auth/token", {
      method: "POST",
      body,
      signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    if (!response.ok) throw new Error("refused");
    const result = (await response.json()) as { refresh_token?: unknown; id_token?: unknown };
    if (
      typeof result.refresh_token !== "string" ||
      !result.refresh_token ||
      typeof result.id_token !== "string" ||
      !result.id_token
    )
      throw new Error("missing token");
    return { refreshToken: result.refresh_token, identityToken: result.id_token };
  } catch {
    // Apple responses and request bodies may contain user credentials. Never log them.
    throw new AppleAuthorizationError("apple_authorization_failed");
  }
}

export async function revokeAppleAuthorization(
  config: AppleAuthorizationConfig,
  clientId: string,
  refreshToken: string,
  fetcher: AppleFetch = fetch,
): Promise<void> {
  try {
    const response = await fetcher("https://appleid.apple.com/auth/revoke", {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: appleClientSecret(config, clientId),
        token: refreshToken,
        token_type_hint: "refresh_token",
      }),
    });
    if (!response.ok) throw new Error("refused");
  } catch {
    throw new AppleAuthorizationError("apple_revocation_failed");
  }
}

function tokenKey(secret: string): Buffer {
  return crypto.createHash("sha256").update("lisa:apple-authorization:v1:").update(secret).digest();
}

/** Account-bound authenticated encryption; reuses the persistent secret with domain separation. */
export function encryptAppleRefreshToken(
  token: string,
  secret: string,
  uid: string,
  clientId: string,
): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", tokenKey(secret), iv);
  cipher.setAAD(Buffer.from(`${uid}\n${clientId}`));
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

export function decryptAppleRefreshToken(
  value: string,
  secret: string,
  uid: string,
  clientId: string,
): string {
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1")
    throw new AppleAuthorizationError("apple_revocation_failed");
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      tokenKey(secret),
      Buffer.from(parts[1]!, "base64url"),
    );
    decipher.setAAD(Buffer.from(`${uid}\n${clientId}`));
    decipher.setAuthTag(Buffer.from(parts[2]!, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3]!, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new AppleAuthorizationError("apple_revocation_failed");
  }
}
