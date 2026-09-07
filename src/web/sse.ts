/**
 * SSE keep-alive (T-11).
 *
 * Every long-lived stream Lisa serves — /events, a streaming /chat turn, a PTY
 * attach, the birth ceremony — can go minutes without a byte: the user is
 * reading, the model is thinking, the tool is running. Anything between the
 * browser and the process treats a silent socket as a dead one. macOS's own
 * network stack, Cloudflare (100 s), nginx (60 s by default) and every
 * corporate proxy will close it, and the browser's EventSource then reconnects
 * — dropping the half-streamed answer, which is what the v0.24 review recorded
 * as "the reply just stops sometimes".
 *
 * A comment line (`: ping`) is the standard fix: it is valid SSE framing that
 * every client — including EventSource — ignores without dispatching an event,
 * so no consumer needs to learn about it.
 *
 * The timer is unref'd, so a hung stream can never be the reason the process
 * stays alive, and it is cleared on close as well as on the first failed
 * write.
 */

/** Interval between keep-alive comments. Comfortably under a 60 s proxy idle. */
export const SSE_HEARTBEAT_MS = 15_000;

/** An SSE comment: valid framing, dispatched to nobody. */
export const SSE_PING = ": ping\n\n";

/**
 * LISA_SSE_HEARTBEAT_MS overrides the interval. Useful behind a proxy with an
 * unusually short idle timeout, and it is how the integration tests observe a
 * ping without waiting 15 s. Floored at 10 ms so a typo cannot turn the
 * keep-alive into a busy loop; garbage falls back to the default.
 */
export function sseHeartbeatMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LISA_SSE_HEARTBEAT_MS?.trim();
  if (!raw) return SSE_HEARTBEAT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return SSE_HEARTBEAT_MS;
  return Math.max(10, n);
}

/** The bit of http.ServerResponse a heartbeat needs (so tests need no socket). */
export interface SseWritable {
  write(chunk: string): unknown;
  readonly writableEnded?: boolean;
  readonly destroyed?: boolean;
}

/** The bit of http.IncomingMessage a heartbeat needs. */
export interface SseClosable {
  on(event: "close", listener: () => void): unknown;
}

/**
 * Start pinging `res`. Returns a stop function; call it when the stream ends.
 * Safe to call the stop function more than once.
 */
export function startSseHeartbeat(
  res: SseWritable,
  intervalMs: number = sseHeartbeatMs(),
): () => void {
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(timer);
      return;
    }
    try {
      res.write(SSE_PING);
    } catch {
      // The socket died between the check and the write — stop rather than
      // throwing from a timer callback (an unhandled throw there is fatal).
      clearInterval(timer);
    }
  }, intervalMs);
  // Never hold the process open for a stream nobody is reading.
  timer.unref?.();
  return () => clearInterval(timer);
}

/** startSseHeartbeat wired to the request's own close event. */
export function attachSseHeartbeat(
  req: SseClosable,
  res: SseWritable,
  intervalMs: number = sseHeartbeatMs(),
): () => void {
  const stop = startSseHeartbeat(res, intervalMs);
  req.on("close", stop);
  return stop;
}
