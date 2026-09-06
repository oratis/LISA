import type http from "node:http";

/**
 * Baseline hardening headers for every HTTP response (T-10).
 *
 * The web server serves a full-tool agent to a browser. On the default
 * loopback bind these headers are belt-and-braces; behind `--host 0.0.0.0` or
 * on the cloud edition they are the only defence-in-depth the browser gets
 * against a few classic cross-site tricks:
 *
 *  - `nosniff`: a JSON/asset response must never be re-interpreted as script or
 *    HTML by a sniffing browser (the assets route serves arbitrary user-dropped
 *    files under a guessed content type).
 *  - `X-Frame-Options: SAMEORIGIN`, not DENY: the main shell embeds the Room
 *    view in a same-origin `<iframe id="roomFrame">`, so same-origin framing is
 *    a product feature; cross-origin framing (clickjacking a "send" button)
 *    is not.
 *  - `Referrer-Policy: no-referrer`: session ids, `?token=` bootstrap URLs and
 *    verification links appear in URLs — none of that should ride along to a
 *    third-party link the model or the user opens from the UI.
 *  - `Permissions-Policy`: the shell never needs camera, geolocation or payment.
 *    Microphone is deliberately NOT listed — the composer's dictation records
 *    audio in the browser, so blocking it would break a real feature.
 *
 * A Content-Security-Policy is intentionally absent: the shell is inline
 * script/CSS and needs a nonce or hash strategy that belongs with the client
 * extraction work (T-2), not here.
 *
 * Applied with `setHeader` at the top of the request handler so every route's
 * later `writeHead(status, {...})` merges with — rather than replaces — them,
 * and a route can still override one on purpose (none does today).
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), geolocation=(), payment=()",
});

export function applySecurityHeaders(res: http.ServerResponse): void {
  if (res.headersSent) return;
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!res.hasHeader(name)) res.setHeader(name, value);
  }
}
