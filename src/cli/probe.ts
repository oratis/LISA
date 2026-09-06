/**
 * `lisa doctor --probe [url]` — ask a running backend how it feels.
 *
 * The review found the daily-driver instance stalling for 5+ seconds at a time
 * with nothing to show for it: launchd's KeepAlive only restarts a process that
 * *exited*, and `/health` answered `{ok:true}`, which a wedged event loop will
 * happily keep saying. So the server side now reports version, uptime, event
 * loop lag percentiles, heap and tenant counts, and this is the client that
 * reads them.
 *
 * Two compatibility rules, because a probe that only works against the newest
 * build is useless for diagnosing an old one:
 *   - every telemetry field is optional and printed only when present;
 *   - `/health` is tried first, `/healthz` second, since which of the two a
 *     deployment exposes has changed over time.
 */
import { dim, fail, grey, heading, ok, rule, warn } from "./colors.js";

/** The extended `/health` body. Everything but `ok` may be missing on an older server. */
export interface HealthPayload {
  ok?: boolean;
  version?: string;
  uptime_s?: number;
  event_loop_lag_ms?: { p50?: number; p99?: number; max?: number };
  heap_used_mb?: number;
  rss_mb?: number;
  tenants?: number;
  pending_turns?: number;
  sessions?: number;
  edition?: string;
}

export interface ProbeResult {
  /** The base that was probed, after normalization. */
  url: string;
  /** The path that answered (`/health` or `/healthz`), when one did. */
  endpoint?: string;
  reachable: boolean;
  status?: number;
  latencyMs: number;
  payload?: HealthPayload;
  error?: string;
  /** Human-readable concerns that do not by themselves mean "down". */
  warnings: string[];
}

export const DEFAULT_PROBE_URL = "http://127.0.0.1:5757";
/** Lag above this is the "5 seconds of nothing" symptom in the making. */
export const LAG_P99_WARN_MS = 1000;
const ENDPOINTS = ["/health", "/healthz"] as const;

/**
 * Accepts what people actually type: nothing, a bare port, `localhost:5757`,
 * a full origin, or the health URL itself pasted back in.
 */
export function normalizeProbeUrl(input?: string | null): string {
  const raw = (input ?? "").trim();
  if (!raw) return DEFAULT_PROBE_URL;
  if (/^\d{2,5}$/.test(raw)) return `http://127.0.0.1:${raw}`;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return withScheme.replace(/\/+$/, "");
  }
  // A pasted `…/health` is the same instance, not a sub-path to probe under.
  if (u.pathname === "/health" || u.pathname === "/healthz") u.pathname = "/";
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.origin}${path}`;
}

export interface ProbeOptions {
  timeoutMs?: number;
  /** Injectable for tests that need a failure without a socket. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export async function probeHealth(
  baseUrl: string,
  opts: ProbeOptions = {},
): Promise<ProbeResult> {
  const url = normalizeProbeUrl(baseUrl);
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? 5000;
  const started = now();
  let lastError = "";
  let lastStatus: number | undefined;

  for (const endpoint of ENDPOINTS) {
    // An own controller rather than AbortSignal.timeout(), so the timer is
    // cleared the moment the request settles instead of lingering for the full
    // timeout — Node 22's test runner counts anything still pending as a leak.
    const ac = new AbortController();
    const timer = setTimeout(
      () => ac.abort(new Error(`timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    try {
      const res = await doFetch(`${url}${endpoint}`, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: ac.signal,
      });
      lastStatus = res.status;
      // 404 on /health is the signal to try /healthz; any other status is the
      // instance's real answer and we report it as such.
      if (res.status === 404 && endpoint !== ENDPOINTS[ENDPOINTS.length - 1]) continue;
      const payload = await readJson(res);
      const latencyMs = now() - started;
      const reachable = res.ok && payload?.ok !== false;
      return {
        url,
        endpoint,
        reachable,
        status: res.status,
        latencyMs,
        payload: payload ?? undefined,
        error: reachable ? undefined : `HTTP ${res.status}`,
        warnings: reachable ? collectWarnings(payload, latencyMs) : [],
      };
    } catch (err) {
      lastError = (err as Error).message || String(err);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    url,
    reachable: false,
    status: lastStatus,
    latencyMs: now() - started,
    error: lastError || (lastStatus ? `HTTP ${lastStatus}` : "unreachable"),
    warnings: [],
  };
}

async function readJson(res: Response): Promise<HealthPayload | null> {
  try {
    const text = await res.text();
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as HealthPayload) : null;
  } catch {
    // A 200 with a non-JSON body still proves the socket is alive; treat the
    // telemetry as simply absent.
    return null;
  }
}

export function collectWarnings(
  payload: HealthPayload | null | undefined,
  latencyMs: number,
): string[] {
  const out: string[] = [];
  const p99 = payload?.event_loop_lag_ms?.p99;
  if (typeof p99 === "number" && p99 > LAG_P99_WARN_MS) {
    out.push(
      `event loop lag p99 ${fmtMs(p99)} > ${LAG_P99_WARN_MS}ms — requests will stall`,
    );
  }
  if (latencyMs > LAG_P99_WARN_MS) {
    out.push(`/health itself took ${fmtMs(latencyMs)} to answer`);
  }
  return out;
}

/** `5d 22h`, `3h 07m`, `48s` — uptime the way `lisa status` would say it. */
export function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${String(h).padStart(2, "0")}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

function fmtMs(ms: number): string {
  return ms >= 100 ? `${Math.round(ms)}ms` : `${Number(ms.toFixed(1))}ms`;
}

/** The probe report, as lines. Split out from printing so tests can read it. */
export function formatProbe(r: ProbeResult): string[] {
  const lines: string[] = [];
  lines.push(heading(`Probe ${r.url}`));
  if (!r.reachable) {
    lines.push(`  ${fail("unreachable")}${grey(`  ${r.error ?? "no response"}`)}`);
    lines.push(
      `  ${dim("is the backend running? try `lisa serve --web` or `lisa autostart status`")}`,
    );
    return lines;
  }

  const p = r.payload ?? {};
  lines.push(
    `  ${ok(`${r.endpoint} ${r.status}`)}${grey(`  ${fmtMs(r.latencyMs)} round-trip`)}`,
  );
  const rows: [string, string][] = [];
  if (p.version) rows.push(["version", p.version]);
  if (p.edition) rows.push(["edition", p.edition]);
  if (typeof p.uptime_s === "number") rows.push(["uptime", formatUptime(p.uptime_s)]);
  const lag = p.event_loop_lag_ms;
  if (lag && (lag.p50 != null || lag.p99 != null || lag.max != null)) {
    const parts: string[] = [];
    if (lag.p50 != null) parts.push(`p50 ${fmtMs(lag.p50)}`);
    if (lag.p99 != null) parts.push(`p99 ${fmtMs(lag.p99)}`);
    if (lag.max != null) parts.push(`max ${fmtMs(lag.max)}`);
    rows.push(["event loop lag", parts.join("  ")]);
  }
  if (typeof p.heap_used_mb === "number") {
    const rss = typeof p.rss_mb === "number" ? `  (rss ${p.rss_mb} MB)` : "";
    rows.push(["heap used", `${p.heap_used_mb} MB${rss}`]);
  } else if (typeof p.rss_mb === "number") {
    rows.push(["rss", `${p.rss_mb} MB`]);
  }
  if (typeof p.tenants === "number") rows.push(["tenants", String(p.tenants)]);
  if (typeof p.sessions === "number") rows.push(["sessions", String(p.sessions)]);
  if (typeof p.pending_turns === "number") rows.push(["pending turns", String(p.pending_turns)]);

  if (rows.length === 0) {
    lines.push(
      `  ${dim("no telemetry — this server answers {ok:true} only (pre-0.25 /health)")}`,
    );
  } else {
    const width = Math.max(...rows.map(([k]) => k.length));
    for (const [k, v] of rows) lines.push(`  ${dim((k + ":").padEnd(width + 2))} ${v}`);
  }
  for (const w of r.warnings) lines.push(`  ${warn(w)}`);
  return lines;
}

/**
 * Run the probe and report. Returns the process exit code: 0 when the instance
 * answered, 1 when it did not — so `lisa doctor --probe || restart` works as a
 * watchdog line in a script or a launchd wrapper.
 */
export async function runProbe(
  target?: string,
  opts: ProbeOptions & { log?: (line: string) => void } = {},
): Promise<number> {
  const log = opts.log ?? ((l: string) => console.log(l));
  log(rule("LISA PROBE"));
  const result = await probeHealth(normalizeProbeUrl(target), opts);
  for (const line of formatProbe(result)) log(line);
  log("");
  log(rule());
  if (!result.reachable) {
    log(fail(`${result.url} is not answering — Lisa's backend is down or wedged`));
    return 1;
  }
  if (result.warnings.length > 0) {
    log(warn(`${result.warnings.length} warning(s) — the instance is up but degraded`));
    return 0;
  }
  log(ok("backend healthy"));
  return 0;
}
