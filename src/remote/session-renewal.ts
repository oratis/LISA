/**
 * Keeps the Mac's account session (LISA_MANAGED_SESSION) alive. Bearer sessions last
 * 30 days and are not renewed by use, so a Mac that stayed signed in that long lost its
 * relay route and managed models (#481, #484). Past half-life, the Mac trades its
 * session for a fresh one at `POST /api/auth/refresh`, saves it where sign-in put it
 * (~/.lisa/config.env) and hands it to the remote host.
 *
 * config.env is the source of truth, not process.env: the Mac app signs out by
 * clearing it without restarting the backend, and a signed-out session must never be
 * brought back. The new token is saved only if the file still holds the one renewed.
 */
import fs from "node:fs";
import { CONFIG_ENV_PATH, parseEnv, saveConfigEnv } from "../env.js";
import { cloudBase } from "./host.js";

const DEFAULT_BASE = "https://cloud.meetlisa.ai";
const TOKEN = /^s1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
export const RENEW_CHECK_MS = 6 * 60 * 60_000;

type Claims = { uid: string; iat: number; exp: number };

/** Unverified claims, only to decide when to renew; the server decides validity. */
export function sessionClaims(token: string): Claims | null {
  if (!TOKEN.test(token)) return null;
  try {
    const c = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
    return typeof c.uid === "string" && Number.isFinite(c.iat) && Number.isFinite(c.exp)
      ? { uid: c.uid, iat: c.iat, exp: c.exp }
      : null;
  } catch {
    return null;
  }
}

export function pastHalfLife(token: string, now = Date.now()): boolean {
  const c = sessionClaims(token);
  return !!c && c.exp > c.iat && now >= c.iat + (c.exp - c.iat) / 2;
}

function saved(): { session: string; base: string } {
  let raw = "";
  try {
    raw = fs.readFileSync(CONFIG_ENV_PATH, "utf8");
  } catch {
    /* no config.env: not signed in */
  }
  const env = new Map(parseEnv(raw));
  return {
    session: env.get("LISA_MANAGED_SESSION")?.trim() ?? "",
    base: env.get("LISA_MANAGED_BASE")?.trim() || DEFAULT_BASE,
  };
}

export type RenewOutcome =
  | "none" // not signed in
  | "not_due" // before half-life
  | "renewed"
  | "unsupported" // the server has no refresh endpoint yet (404)
  | "refused" // 401/403: the session is no longer valid; signing in again is needed
  | "changed" // config.env changed while renewing (signed out or in): left alone
  | "failed"; // network or server error: tried again on the next check

export async function renewManagedSession(
  onRenewed: (token: string) => void = () => {},
  opts: { now?: number; fetch?: typeof fetch } = {},
): Promise<RenewOutcome> {
  const { session, base: rawBase } = saved();
  const claims = session ? sessionClaims(session) : null;
  if (!claims) return "none";
  if (!pastHalfLife(session, opts.now)) return "not_due";
  let base: string;
  try {
    base = cloudBase(rawBase);
  } catch {
    return "failed";
  }
  let response: Response;
  try {
    response = await (opts.fetch ?? fetch)(`${base}/api/auth/refresh`, {
      method: "POST",
      headers: { authorization: `Bearer ${session}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return "failed";
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 404) return "unsupported";
    return response.status === 401 || response.status === 403 ? "refused" : "failed";
  }
  let token: unknown;
  try {
    token = ((await response.json()) as { token?: unknown }).token;
  } catch {
    return "failed";
  }
  const fresh = typeof token === "string" ? sessionClaims(token) : null;
  if (!fresh || fresh.uid !== claims.uid || fresh.exp <= claims.exp) return "failed";
  const current = saved();
  if (current.session !== session || current.base !== rawBase) return "changed";
  await saveConfigEnv({ LISA_MANAGED_SESSION: token as string });
  onRenewed(token as string);
  return "renewed";
}

/** Check now and every RENEW_CHECK_MS; returns the stop function. Never throws. */
export function startSessionRenewal(
  onRenewed: (token: string) => void,
  intervalMs = RENEW_CHECK_MS,
): () => void {
  let running = false;
  const check = () => {
    if (running) return;
    running = true;
    void renewManagedSession(onRenewed)
      .catch(() => "failed")
      .finally(() => (running = false));
  };
  const first = setTimeout(check, 0);
  const timer = setInterval(check, intervalMs);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
