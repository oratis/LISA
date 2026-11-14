import type http from "node:http";

/**
 * Work a server's close hook starts that should finish before the process
 * exits, such as stopping the Claude processes a remote Mac controller started.
 */
const pending = new WeakMap<http.Server, Promise<unknown>[]>();

export function trackShutdown(server: http.Server, work: Promise<unknown>): void {
  pending.set(server, [...(pending.get(server) ?? []), work]);
}

type SignalTarget = {
  on(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  exit(code: number): void;
};

/**
 * `lisa serve --web` stops on SIGTERM (launchd, kill) and SIGINT (Ctrl-C) by
 * closing the server, so its shutdown hook runs, then exiting. Without this the
 * hook never ran in production and a detached agent outlived its backend.
 * A second signal exits at once; `graceMs` bounds the wait for tracked work.
 */
export function exitOnSignals(
  server: http.Server,
  opts: { target?: SignalTarget; graceMs?: number; log?: (line: string) => void } = {},
): void {
  const target = opts.target ?? process;
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) {
      target.exit(1);
      return;
    }
    stopping = true;
    opts.log?.(`[web] ${signal}: shutting down`);
    let exited = false;
    const exit = () => {
      if (exited) return;
      exited = true;
      target.exit(0);
    };
    setTimeout(exit, opts.graceMs ?? 5000).unref();
    // 'close' listeners registered by startWebServer run before this callback.
    server.close(() => {
      void Promise.allSettled(pending.get(server) ?? []).then(exit);
    });
    // Open SSE streams would otherwise keep close() waiting.
    server.closeAllConnections();
  };
  target.on("SIGTERM", () => stop("SIGTERM"));
  target.on("SIGINT", () => stop("SIGINT"));
}
