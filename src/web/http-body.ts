/**
 * Bounded request-body reader (PLAN_ACCOUNTS_BILLING hardening, #260/#264/#266).
 *
 * Every pre-auth / pre-quota entrypoint that slurps a whole request body used a
 * `for await (const chunk of req) body += chunk` loop with NO ceiling — a client
 * could stream an endless body and OOM the instance before any gate ran. This
 * reads with a hard byte cap and rejects past it with `BodyTooLargeError`; the
 * caller answers 413.
 *
 * It deliberately does NOT destroy the socket on overflow — it just stops
 * consuming, so the remaining bytes stay in the kernel buffer under TCP
 * backpressure (bounded) while the caller writes a 413 with `Connection: close`.
 */
import type http from "node:http";

export class BodyTooLargeError extends Error {
  constructor(public readonly limitBytes: number) {
    super("body_too_large");
    this.name = "BodyTooLargeError";
  }
}

/** Default cap for control-plane JSON (auth, IAP JWS, checkout, webhooks). */
export const CTRL_BODY_LIMIT = 1_048_576; // 1 MiB

/**
 * Read a request body as UTF-8 text, aborting past `limitBytes` with a
 * `BodyTooLargeError`. Uses explicit listeners (not `for await`) so overflow
 * neither auto-destroys the socket nor loses the ability to answer 413.
 */
export function readCappedText(req: http.IncomingMessage, limitBytes: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onErr);
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) {
        // Stop consuming; removing the listener returns the stream to paused
        // mode so the rest of the body backs up in the kernel buffer instead of
        // our heap. The caller closes the connection.
        settle(() => reject(new BodyTooLargeError(limitBytes)));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => settle(() => resolve(Buffer.concat(chunks).toString("utf8")));
    const onErr = (err: Error) => settle(() => reject(err));
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onErr);
  });
}
