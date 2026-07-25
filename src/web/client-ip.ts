import type { IncomingHttpHeaders } from "node:http";
import { isIP } from "node:net";

function trustedProxyHops(env: NodeJS.ProcessEnv): number {
  const raw = env.LISA_TRUST_PROXY_HOPS?.trim() ?? "";
  if (!/^\d+$/.test(raw)) return 0;
  const hops = Number(raw);
  return Number.isSafeInteger(hops) && hops > 0 && hops <= 16 ? hops : 0;
}

/**
 * Resolve a rate-limit key without trusting caller-controlled forwarding
 * headers by default.
 *
 * When LISA_TRUST_PROXY_HOPS=N is explicitly configured, walk the
 * X-Forwarded-For chain from the trusted socket peer toward the client and
 * select the address immediately before those N trusted proxies. Choosing from
 * the right prevents a caller-prepended fake first hop from bypassing limits.
 */
export function resolveClientIp(
  headers: IncomingHttpHeaders,
  remoteAddr: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fallback = isIP(remoteAddr) ? remoteAddr : remoteAddr || "unknown";
  const hops = trustedProxyHops(env);
  if (hops === 0) return fallback;

  const forwarded = headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
  if (!raw) return fallback;

  const chain = raw.split(",").map((part) => part.trim());
  if (chain.length === 0 || chain.some((address) => isIP(address) === 0)) {
    return fallback;
  }
  if (isIP(remoteAddr)) chain.push(remoteAddr);

  const clientIndex = chain.length - 1 - hops;
  return clientIndex >= 0 ? chain[clientIndex]! : fallback;
}
