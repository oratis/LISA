import type { Edition } from "../edition.js";

/**
 * Parse the canonical public origin used in security-sensitive outbound links.
 * Paths, credentials, query strings, and fragments are rejected so callers
 * cannot accidentally turn an origin setting into an open redirect template.
 */
export function configuredPublicOrigin(
  env: NodeJS.ProcessEnv = process.env,
  edition: Edition = env.LISA_EDITION === "cloud" ? "cloud" : "mac",
): string | null {
  const raw = env.LISA_PUBLIC_ORIGIN?.trim();
  if (!raw) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("LISA_PUBLIC_ORIGIN must be an absolute http(s) origin");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("LISA_PUBLIC_ORIGIN must use https");
  }
  if (edition === "cloud" && parsed.protocol !== "https:") {
    throw new Error("LISA_PUBLIC_ORIGIN must use https in the cloud edition");
  }
  if (parsed.username || parsed.password) {
    throw new Error("LISA_PUBLIC_ORIGIN must not contain credentials");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("LISA_PUBLIC_ORIGIN must not contain a path, query, or fragment");
  }
  return parsed.origin;
}

export function requireCloudPublicOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const origin = configuredPublicOrigin(env, "cloud");
  if (!origin) {
    throw new Error(
      "LISA_PUBLIC_ORIGIN is required in the cloud edition " +
        "(for example https://cloud.meetlisa.ai)",
    );
  }
  return origin;
}

export function verificationUrl(origin: string, rawToken: string): string {
  const url = new URL("/verify", origin);
  url.searchParams.set("token", rawToken);
  return url.toString();
}
