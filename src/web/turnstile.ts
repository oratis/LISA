/**
 * Cloudflare Turnstile verification (S3) — the bot gate on account signup.
 *
 * Every registration ignites an LLM birth call and mints a free usage window,
 * so /api/auth/register is a direct cost target for script farms. When both
 * env vars are set the login page renders the widget and the server requires
 * a valid token; unset ⇒ everything behaves exactly as before (default-OFF,
 * same philosophy as the Apple/Google channels).
 *
 * Env: LISA_TURNSTILE_SITE_KEY (public, sent to the page),
 *      LISA_TURNSTILE_SECRET   (server-side verify).
 * Zero deps: one form-encoded POST to Cloudflare's siteverify endpoint.
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface TurnstileConfig {
  siteKey: string | null;
  secret: string | null;
  /** Both halves present — the widget draws and the server enforces. */
  enabled: boolean;
}

export function turnstileConfig(env: NodeJS.ProcessEnv = process.env): TurnstileConfig {
  const siteKey = env.LISA_TURNSTILE_SITE_KEY?.trim() || null;
  const secret = env.LISA_TURNSTILE_SECRET?.trim() || null;
  return { siteKey, secret, enabled: !!(siteKey && secret) };
}

/**
 * Verify a widget token. Fails CLOSED on Cloudflare being unreachable — a
 * signup gate that opens when the bot-checker is down invites exactly the
 * traffic it exists to stop (retrying is cheap for a human, free for no one).
 */
export async function verifyTurnstile(
  token: string,
  remoteIp: string,
  cfg: TurnstileConfig = turnstileConfig(),
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  if (!cfg.enabled || !cfg.secret) return true; // gate off ⇒ pass-through
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret: cfg.secret, response: token });
    if (remoteIp) body.set("remoteip", remoteIp);
    const res = await fetchFn(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) return false;
    const parsed = (await res.json().catch(() => ({}))) as { success?: boolean };
    return parsed.success === true;
  } catch {
    return false;
  }
}
