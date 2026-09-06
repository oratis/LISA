/**
 * Process health for the web server (T-3).
 *
 * Two things live here:
 *
 *  1. An event-loop lag monitor built on `perf_hooks.monitorEventLoopDelay`.
 *     The v0.24 review caught the daily-driver instance freezing for 5–12 s
 *     (a whole-file read + utf8 decode tripping a major GC) while `/health`
 *     still answered `{ok:true}` — because it answered *after* the stall. The
 *     histogram accumulates continuously in libuv, and a 5 s timer reads it
 *     out and resets it, so a stall that already ended still shows up in the
 *     next `/health` (as the window's p99/max, and as the worst reading of
 *     the last minute) and a WARNING lands in the log at the time it
 *     happened, not when someone finally looks.
 *
 *     On reset() semantics: `reset()` zeroes the histogram, and the very next
 *     libuv sample can attribute delay accumulated across the reset boundary
 *     to the new window rather than the old one. That misplaces at most one
 *     resolution tick (10 ms) across a window edge — irrelevant to a monitor
 *     whose thresholds are 1 s and 5 s — so the simple reset-then-read window
 *     is what we use. The 60 s ring of window snapshots on top is what makes
 *     a stall survive long enough for an operator to actually see it.
 *
 *  2. A self-watchdog. launchd's KeepAlive and Cloud Run's probes restart a
 *     process that *crashes*; neither notices one that is alive but so bogged
 *     down that every request takes seconds. If p99 lag stays above
 *     LISA_WATCHDOG_LAG_MS (default 5000; 0 disables) for a full minute of
 *     consecutive windows, we log an ERROR with a sampling hint and exit(1)
 *     so the supervisor gives users a fresh process. A loop that is *fully*
 *     wedged cannot run this timer at all — that case belongs to an external
 *     probe; this covers the "alive but useless" band in between.
 *
 * Everything is injectable (histogram, clock, logger, exit), so the policy is
 * unit-tested without ever blocking a real event loop; the readout timer is
 * unref'd, so the monitor never keeps a process — or a test — alive.
 */
import { monitorEventLoopDelay } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logError, logWarn } from "../log.js";

/**
 * The slice of `perf_hooks.IntervalHistogram` we depend on. Declared
 * structurally so tests can script a histogram without a real event loop.
 * Values are nanoseconds, as perf_hooks reports them.
 */
export interface LagHistogram {
  percentile(p: number): number;
  readonly max: number;
  readonly count: number;
  reset(): void;
  enable(): boolean;
  disable(): boolean;
}

/** Lag over one readout window, in milliseconds. */
export interface LagSnapshot {
  p50: number;
  p99: number;
  max: number;
  samples: number;
  /** Wall clock (ms) when the window closed. */
  at: number;
}

export interface EventLoopMonitorOptions {
  /** Histogram to read. Defaults to a real `monitorEventLoopDelay`. */
  histogram?: LagHistogram;
  /** libuv sampling resolution for the default histogram. Default 10 ms. */
  resolutionMs?: number;
  /** Window length between readouts. Default 5 s. */
  windowMs?: number;
  /** p99 above this logs a WARNING (rate-limited). Default 1000 ms. */
  warnMs?: number;
  /** Minimum gap between two lag WARNINGs. Default 60 s. */
  warnEveryMs?: number;
  /** p99 above this for `watchdogForMs` triggers exit. 0 disables. Default 5000. */
  watchdogMs?: number;
  /** How long p99 must stay above `watchdogMs`. Default 60 s. */
  watchdogForMs?: number;
  /** Test seams. */
  now?: () => number;
  exit?: (code: number) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

const DEFAULT_RESOLUTION_MS = 10;
const DEFAULT_WINDOW_MS = 5_000;
const DEFAULT_WARN_MS = 1_000;
const DEFAULT_WARN_EVERY_MS = 60_000;
export const DEFAULT_WATCHDOG_LAG_MS = 5_000;
const DEFAULT_WATCHDOG_FOR_MS = 60_000;
/** Windows kept for the "worst over the last minute" readout. */
const RING_MS = 60_000;
const NS_PER_MS = 1e6;

/**
 * LISA_WATCHDOG_LAG_MS: "0" disables the self-watchdog; unset/garbage ⇒ the
 * default; anything else is a millisecond threshold. Garbage falls back to the
 * default rather than to "off" — a typo in a plist must not silently remove a
 * safety net (fail closed).
 */
export function watchdogThresholdFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LISA_WATCHDOG_LAG_MS?.trim();
  if (raw === undefined || raw === "") return DEFAULT_WATCHDOG_LAG_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_WATCHDOG_LAG_MS;
  return n;
}

export class EventLoopMonitor {
  private readonly histogram: LagHistogram;
  private readonly windowMs: number;
  private readonly warnMs: number;
  private readonly warnEveryMs: number;
  private readonly watchdogMs: number;
  private readonly watchdogForMs: number;
  private readonly now: () => number;
  private readonly exit: (code: number) => void;
  private readonly warn: (msg: string) => void;
  private readonly error: (msg: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private ring: LagSnapshot[] = [];
  private lastWarnAt = -Infinity;
  /** Wall clock when p99 first exceeded the watchdog threshold in this streak. */
  private overSince: number | null = null;
  private tripped = false;

  constructor(opts: EventLoopMonitorOptions = {}) {
    this.histogram =
      opts.histogram ??
      (monitorEventLoopDelay({
        resolution: opts.resolutionMs ?? DEFAULT_RESOLUTION_MS,
      }) as unknown as LagHistogram);
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.warnMs = opts.warnMs ?? DEFAULT_WARN_MS;
    this.warnEveryMs = opts.warnEveryMs ?? DEFAULT_WARN_EVERY_MS;
    this.watchdogMs = opts.watchdogMs ?? DEFAULT_WATCHDOG_LAG_MS;
    this.watchdogForMs = opts.watchdogForMs ?? DEFAULT_WATCHDOG_FOR_MS;
    this.now = opts.now ?? Date.now;
    this.exit = opts.exit ?? ((code) => process.exit(code));
    this.warn = opts.warn ?? logWarn;
    this.error = opts.error ?? logError;
  }

  /** Start sampling and the readout timer (unref'd). Idempotent. */
  start(): this {
    if (this.timer) return this;
    this.histogram.enable();
    this.timer = setInterval(() => this.tick(), this.windowMs);
    // The monitor must never be the reason a process (or a test) stays up.
    this.timer.unref();
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.histogram.disable();
  }

  /** Whether the watchdog would ever fire. */
  get watchdogEnabled(): boolean {
    return this.watchdogMs > 0;
  }

  /**
   * Close the current window: summarize the histogram, reset it, apply the
   * warning + watchdog policy. Public so tests drive it without a real clock.
   */
  tick(): LagSnapshot {
    const at = this.now();
    const h = this.histogram;
    // An empty window means libuv recorded nothing yet; percentile() on an
    // empty histogram is not meaningfully defined, so report a flat zero
    // rather than whatever the native default happens to be.
    const samples = h.count;
    const snap: LagSnapshot = {
      p50: samples > 0 ? h.percentile(50) / NS_PER_MS : 0,
      p99: samples > 0 ? h.percentile(99) / NS_PER_MS : 0,
      max: samples > 0 ? h.max / NS_PER_MS : 0,
      samples,
      at,
    };
    h.reset();

    this.ring.push(snap);
    const cutoff = at - RING_MS;
    while (this.ring.length > 1 && this.ring[0]!.at < cutoff) this.ring.shift();

    if (snap.p99 > this.warnMs && at - this.lastWarnAt >= this.warnEveryMs) {
      this.lastWarnAt = at;
      this.warn(
        `[health] event loop lag p99=${fmt(snap.p99)}ms max=${fmt(snap.max)}ms over the last ${Math.round(
          this.windowMs / 1000,
        )}s`,
      );
    }

    if (this.watchdogMs > 0) {
      if (snap.p99 > this.watchdogMs) {
        // A window closing at `at` describes the lag of the windowMs BEFORE
        // it, so the streak really started a window earlier than this
        // readout. With that, N consecutive bad windows measure exactly
        // N × windowMs and "for 60 s" is 12 five-second windows.
        this.overSince ??= at - this.windowMs;
        if (at - this.overSince >= this.watchdogForMs && !this.tripped) {
          this.tripped = true;
          this.error(
            `[health] event loop p99 lag has stayed above ${this.watchdogMs}ms for ` +
              `${Math.round((at - this.overSince) / 1000)}s (latest p99=${fmt(snap.p99)}ms max=${fmt(snap.max)}ms) — ` +
              `exiting so the supervisor (launchd KeepAlive / Cloud Run) restarts a fresh process. ` +
              `To see what blocked the loop next time, sample it while it is slow: ` +
              `\`sample ${process.pid} 5\` (macOS) or \`node --cpu-prof\`, and look for a large ` +
              `fs.readFile → utf8 decode → GC frame. LISA_WATCHDOG_LAG_MS=0 disables this watchdog.`,
          );
          this.exit(1);
        }
      } else {
        this.overSince = null;
      }
    }
    return snap;
  }

  /** The most recently closed window, or null before the first tick. */
  latest(): LagSnapshot | null {
    return this.ring.length ? this.ring[this.ring.length - 1]! : null;
  }

  /** Worst p99 / max over the windows of the last minute. */
  lastMinute(): { p99: number; max: number } {
    let p99 = 0;
    let max = 0;
    for (const s of this.ring) {
      if (s.p99 > p99) p99 = s.p99;
      if (s.max > max) max = s.max;
    }
    return { p99, max };
  }

  /**
   * "Currently fine" = the last closed window's p99 stayed under the warn
   * line. Deliberately p99 and not max: a single 2 s GC pause is one sample
   * in a 5 s window and worth a log line, but it does not make the process
   * unhealthy — sustained lag does.
   */
  healthy(): boolean {
    const l = this.latest();
    return !l || l.p99 <= this.warnMs;
  }
}

function fmt(ms: number): string {
  return ms >= 100 ? String(Math.round(ms)) : ms.toFixed(1);
}

/** Live process counters the server hands to the health payload. */
export interface HealthRuntimeCounters {
  tenants: number;
  pending_turns: number;
  sessions: number;
}

export interface HealthPayload {
  ok: boolean;
  version: string;
  uptime_s: number;
  event_loop_lag_ms: { p50: number; p99: number; max: number };
  /** Worst readings over the last minute — so a stall that just ended is still visible. */
  event_loop_lag_1m_ms: { p99: number; max: number };
  heap_used_mb: number;
  rss_mb: number;
  tenants: number;
  pending_turns: number;
  sessions: number;
  edition: string;
  watchdog_lag_ms: number;
}

/**
 * The `GET /health` body. Deliberately no I/O: everything is read from memory
 * (window snapshot, process counters, cached package version) so the endpoint
 * itself cannot become the thing that lags.
 */
export function healthPayload(
  monitor: EventLoopMonitor,
  counters: HealthRuntimeCounters,
  edition: string,
  watchdogLagMs: number,
): HealthPayload {
  const latest = monitor.latest();
  const minute = monitor.lastMinute();
  const mem = process.memoryUsage();
  const round1 = (n: number) => Math.round(n * 10) / 10;
  return {
    ok: monitor.healthy(),
    version: packageVersion(),
    uptime_s: Math.round(process.uptime()),
    event_loop_lag_ms: {
      p50: round1(latest?.p50 ?? 0),
      p99: round1(latest?.p99 ?? 0),
      max: round1(latest?.max ?? 0),
    },
    event_loop_lag_1m_ms: { p99: round1(minute.p99), max: round1(minute.max) },
    heap_used_mb: round1(mem.heapUsed / 1048576),
    rss_mb: round1(mem.rss / 1048576),
    tenants: counters.tenants,
    pending_turns: counters.pending_turns,
    sessions: counters.sessions,
    edition,
    watchdog_lag_ms: watchdogLagMs,
  };
}

let cachedVersion: string | null = null;
/**
 * package.json version, read once. dist/web/health.js and src/web/health.ts
 * both sit two levels below the package root, so `../../package.json` holds
 * in dev (tsx) and in the installed tarball alike.
 */
export function packageVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.resolve(here, "..", "..", "package.json"), "utf8")) as {
      version?: string;
    };
    cachedVersion = pkg.version ?? "unknown";
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion;
}
