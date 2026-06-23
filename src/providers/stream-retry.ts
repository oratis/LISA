import { setTimeout as delay } from "node:timers/promises";

export interface StreamRetryOpts {
  /** Max number of *additional* attempts after the first (default 2 → 3 total). */
  maxRetries?: number;
  /** Linear backoff base; attempt N waits baseDelayMs * N (default 400). */
  baseDelayMs?: number;
  /** Abort signal for the turn; a triggered signal stops retrying. */
  signal?: AbortSignal;
}

/**
 * True for transient streaming failures that are safe to retry *as long as no
 * output has been emitted yet*. Chiefly the Anthropic SDK's "request ended
 * without sending any chunks" — a 200 response whose SSE body closed before any
 * event arrived — plus connection resets / premature closes commonly caused by
 * HTTP proxies (Clash, one-api relays) tearing down an idle CONNECT tunnel
 * during a long time-to-first-byte on a large request.
 *
 * Crucially never matches a user abort: APIUserAbortError / AbortError mean the
 * turn was cancelled on purpose and must surface, not retry.
 */
export function isRetryableStreamError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  if (name === "APIUserAbortError" || name === "AbortError") return false;
  if (name === "APIConnectionError" || name === "APIConnectionTimeoutError") {
    return true;
  }
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("without sending any chunks") ||
    msg.includes("premature close") ||
    msg.includes("socket hang up") ||
    msg.includes("econnreset") ||
    msg.includes("terminated") ||
    msg.includes("network error") ||
    msg.includes("fetch failed")
  );
}

/**
 * Run a streaming attempt with bounded retries for transient empty-stream
 * failures. The SDK's own retries don't cover these: the error is thrown while
 * iterating the stream, *after* the HTTP request already returned 200, so it
 * escapes the SDK's request-level retry and reaches the user as a hard error.
 *
 * The attempt receives `markEmitted`, which it MUST call the moment it forwards
 * the first text/thinking delta. Once called, a later failure is surfaced
 * rather than retried — we can't replay already-streamed output without
 * duplicating it in the UI. The reported failure ("…any chunks") emits nothing,
 * so it always stays retryable.
 *
 * Per-attempt accumulator state must live *inside* `attempt` so it resets on
 * each retry.
 */
export async function withStreamRetry<T>(
  opts: StreamRetryOpts,
  attempt: (markEmitted: () => void) => Promise<T>,
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 2;
  const baseDelayMs = opts.baseDelayMs ?? 400;
  let lastErr: unknown;
  for (let i = 0; i <= maxRetries; i++) {
    let emitted = false;
    try {
      return await attempt(() => {
        emitted = true;
      });
    } catch (err) {
      lastErr = err;
      if (
        i === maxRetries ||
        emitted ||
        opts.signal?.aborted ||
        !isRetryableStreamError(err)
      ) {
        throw err;
      }
      try {
        await delay(baseDelayMs * (i + 1), undefined, { signal: opts.signal });
      } catch {
        // Signal aborted during backoff → stop retrying, surface the error.
        throw err;
      }
    }
  }
  throw lastErr;
}
