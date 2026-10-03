/**
 * Hosted-edition governance for the two outbound web tools.
 *
 * `web_search` and `web_fetch` are the only cloud tools that make the service
 * itself open a connection to a destination the model chose. They are admitted
 * to the cloud allow-list ONLY through this module, which adds what a
 * multi-tenant, internet-facing deployment needs on top of the SSRF guard in
 * web_fetch.ts:
 *
 *  - an explicit opt-in (`LISA_CLOUD_WEB_TOOLS=1`): the tools are OFF unless
 *    the operator turns them on, checked both when the tool list is built and
 *    again on every call;
 *  - per-tenant hourly limits, keyed by the server-derived uid of the active
 *    request scope (never by anything the client or the model supplies);
 *  - a hard wall-clock deadline per call;
 *  - a stricter outbound policy (standard web ports only).
 *
 * Everything here fails CLOSED: no tenant scope, a full limiter table or an
 * unparseable limit all refuse the call rather than letting it through.
 */
import type { ToolDefinition } from "../types.js";
import { logInfo, redactId } from "../log.js";
import { scopedUid } from "../paths.js";
import {
  createWebFetchTool,
  type OutboundPolicy,
  type SafeFetchDependencies,
} from "./web_fetch.js";
import { createWebSearchTool } from "./web_search.js";

export const CLOUD_WEB_TOOL_NAMES: ReadonlySet<string> = new Set(["web_search", "web_fetch"]);

export type CloudWebToolKind = "search" | "fetch";

type Env = Record<string, string | undefined>;

/**
 * The hosted web tools are opt-in. They send data to third parties the privacy
 * policy has to name first, so the safe state is the one a forgotten or
 * dropped variable produces: only an explicit `1 | true | on | yes` enables
 * them. Unset, empty, or anything else means off.
 */
export function cloudWebToolsEnabled(env: Env = process.env): boolean {
  const raw = (env.LISA_CLOUD_WEB_TOOLS ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export interface CloudWebLimits {
  searchesPerWindow: number;
  fetchesPerWindow: number;
  windowMs: number;
  maxTenants: number;
  timeoutMs: number;
}

export const DEFAULT_CLOUD_WEB_LIMITS: CloudWebLimits = {
  searchesPerWindow: 30,
  fetchesPerWindow: 60,
  windowMs: 60 * 60_000,
  maxTenants: 10_000,
  timeoutMs: 20_000,
};

/**
 * Unset ⇒ the default. Set but not a non-negative integer ⇒ 0, i.e. the tool
 * refuses every call: a typo in an abuse limit must never widen it.
 */
function limitFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export function cloudWebLimits(env: Env = process.env): CloudWebLimits {
  const d = DEFAULT_CLOUD_WEB_LIMITS;
  const maxTenants = limitFromEnv(env.LISA_CLOUD_WEB_MAX_TENANTS, d.maxTenants);
  const timeoutMs = limitFromEnv(env.LISA_CLOUD_WEB_TIMEOUT_MS, d.timeoutMs);
  return {
    searchesPerWindow: limitFromEnv(env.LISA_CLOUD_WEB_SEARCH_PER_HOUR, d.searchesPerWindow),
    fetchesPerWindow: limitFromEnv(env.LISA_CLOUD_WEB_FETCH_PER_HOUR, d.fetchesPerWindow),
    windowMs: d.windowMs,
    maxTenants,
    // The deadline is not something an operator may switch off: a bad or zero
    // value falls back to the default, and the ceiling stops a "generous"
    // setting from pinning request workers on slow hosts.
    timeoutMs: timeoutMs > 0 ? Math.min(timeoutMs, 60_000) : d.timeoutMs,
  };
}

/**
 * The hosted outbound policy layered on the baseline SSRF guard: only the
 * standard web ports — the service must not be usable to reach other
 * protocols' ports on third-party hosts (or to port-scan them) from its own
 * address — and internal names (cloud metadata, `*.internal`, `*.local`, …)
 * refused by name, before DNS is consulted.
 */
export const HOSTED_OUTBOUND_POLICY: OutboundPolicy = {
  allowedPorts: [80, 443],
  refuseInternalNames: true,
};

export type CloudWebRefusalCode =
  "web_tools_disabled" | "no_tenant_scope" | "rate_limited" | "limiter_at_capacity";

/** Thrown into the tool result; the agent loop reports it to the model as a tool error. */
export class CloudWebToolError extends Error {
  readonly status: 403 | 429 | 503;
  readonly code: CloudWebRefusalCode;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    status: 403 | 429 | 503,
    code: CloudWebRefusalCode,
    message: string,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "CloudWebToolError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type RateDecision =
  | { ok: true; used: number; limit: number }
  | { ok: false; reason: "rate_limited" | "limiter_at_capacity"; retryAfterMs: number };

interface TenantWindow {
  search: number[];
  fetch: number[];
}

/**
 * Sliding-window call counters, partitioned by uid.
 *
 * Bounded two ways: each tenant holds at most `limit` timestamps per tool, and
 * the table holds at most `maxTenants` tenants. Idle tenants are dropped once
 * every timestamp has aged out of the window (that loses no information). When
 * the table is full of LIVE windows a new tenant is refused instead of evicting
 * someone else's counter — evicting would hand the evicted tenant a fresh
 * quota, which is exactly the fail-open an abuse limit must not have.
 *
 * In-memory and per-process: with N instances the effective ceiling is N× the
 * configured limit. Fine for the single-instance deployment; a shared store is
 * the follow-up if the service scales out.
 */
export class TenantWebRateLimiter {
  private readonly tenants = new Map<string, TenantWindow>();
  private readonly now: () => number;

  constructor(
    private readonly options: { windowMs: number; maxTenants: number; now?: () => number },
  ) {
    if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
      throw new Error("cloud web limiter windowMs must be positive");
    }
    if (!Number.isInteger(options.maxTenants) || options.maxTenants < 0) {
      throw new Error("cloud web limiter maxTenants must be a non-negative integer");
    }
    this.now = options.now ?? Date.now;
  }

  /** Count one call for `uid`, or say why it may not proceed. */
  take(uid: string, kind: CloudWebToolKind, limit: number): RateDecision {
    const now = this.now();
    const cutoff = now - this.options.windowMs;
    if (!Number.isInteger(limit) || limit <= 0) {
      return { ok: false, reason: "rate_limited", retryAfterMs: this.options.windowMs };
    }
    let entry = this.tenants.get(uid);
    if (!entry) {
      if (this.tenants.size >= this.options.maxTenants) this.sweep();
      if (this.tenants.size >= this.options.maxTenants) {
        return { ok: false, reason: "limiter_at_capacity", retryAfterMs: 60_000 };
      }
      entry = { search: [], fetch: [] };
      this.tenants.set(uid, entry);
    }
    const stamps = entry[kind];
    while (stamps.length > 0 && stamps[0]! <= cutoff) stamps.shift();
    if (stamps.length >= limit) {
      return {
        ok: false,
        reason: "rate_limited",
        retryAfterMs: Math.max(1, stamps[0]! + this.options.windowMs - now),
      };
    }
    stamps.push(now);
    return { ok: true, used: stamps.length, limit };
  }

  /** Calls counted for `uid` in the current window. Read-only. */
  usage(uid: string): { search: number; fetch: number } {
    const entry = this.tenants.get(uid);
    if (!entry) return { search: 0, fetch: 0 };
    const cutoff = this.now() - this.options.windowMs;
    return {
      search: entry.search.filter((at) => at > cutoff).length,
      fetch: entry.fetch.filter((at) => at > cutoff).length,
    };
  }

  /** Drop tenants whose every timestamp has left the window. */
  sweep(): void {
    const cutoff = this.now() - this.options.windowMs;
    for (const [uid, entry] of this.tenants) {
      const live = (stamps: number[]): boolean =>
        stamps.length > 0 && stamps[stamps.length - 1]! > cutoff;
      if (!live(entry.search) && !live(entry.fetch)) this.tenants.delete(uid);
    }
  }

  size(): number {
    return this.tenants.size;
  }
}

export interface CloudWebAuditEvent {
  uid: string;
  tool: "web_search" | "web_fetch";
  outcome: "ok" | "error" | CloudWebRefusalCode;
  /** Destination host for web_fetch — never the path, query or the search text. */
  host?: string;
  ms: number;
}

export interface CloudWebDependencies extends SafeFetchDependencies {
  env?: Env;
  /** The tenant of the active request scope. Defaults to the server-derived scope uid. */
  uid?: () => string | null;
  limiter?: TenantWebRateLimiter;
  audit?: (event: CloudWebAuditEvent) => void;
  now?: () => number;
}

let processLimiter: TenantWebRateLimiter | null = null;

function sharedLimiter(limits: CloudWebLimits): TenantWebRateLimiter {
  processLimiter ??= new TenantWebRateLimiter({
    windowMs: limits.windowMs,
    maxTenants: limits.maxTenants,
  });
  return processLimiter;
}

/**
 * One line per call: who (redacted), which tool, which host, how it ended.
 * Deliberately no URL path/query and no search text — both routinely carry
 * personal data, and logs are operational telemetry, not a transcript.
 */
function defaultAudit(event: CloudWebAuditEvent): void {
  logInfo(
    `[cloud-web] uid=${redactId(event.uid)} tool=${event.tool} outcome=${event.outcome}` +
      `${event.host ? ` host=${event.host}` : ""} ms=${event.ms}`,
  );
}

// Module-private on purpose (not Symbol.for): only a tool built here can carry
// the mark, while a `{ ...tool }` copy made by a later wrapper still does.
const GOVERNED = Symbol("lisa.cloud-web.governed");

function isGoverned(tool: ToolDefinition): boolean {
  return (tool as unknown as Record<symbol, unknown>)[GOVERNED] === true;
}

function hostOf(input: unknown): string | undefined {
  const url = (input as { url?: unknown } | null)?.url;
  if (typeof url !== "string") return undefined;
  try {
    return new URL(url).hostname.slice(0, 253);
  } catch {
    return undefined;
  }
}

function govern(
  base: ToolDefinition,
  kind: CloudWebToolKind,
  deps: CloudWebDependencies,
): ToolDefinition {
  const name = base.name as "web_search" | "web_fetch";
  const governed: ToolDefinition = {
    ...base,
    async execute(input, ctx) {
      const env = deps.env ?? process.env;
      const clock = deps.now ?? Date.now;
      const audit = deps.audit ?? defaultAudit;
      const startedAt = clock();
      const host = kind === "fetch" ? hostOf(input) : undefined;
      const record = (uid: string, outcome: CloudWebAuditEvent["outcome"]): void => {
        try {
          audit({ uid, tool: name, outcome, ...(host ? { host } : {}), ms: clock() - startedAt });
        } catch {
          // An audit sink failure must not change the outcome of the call.
        }
      };
      const refuse = (uid: string, error: CloudWebToolError): never => {
        record(uid, error.code);
        throw error;
      };

      const uid = (deps.uid ?? scopedUid)();
      if (!cloudWebToolsEnabled(env)) {
        return refuse(
          uid ?? "-",
          new CloudWebToolError(
            403,
            "web_tools_disabled",
            `${name} is not enabled on this service (403).`,
          ),
        );
      }
      // The limit is per tenant, so a call that cannot be attributed to one is
      // refused — never run against a shared or anonymous bucket.
      if (!uid) {
        return refuse(
          "-",
          new CloudWebToolError(
            403,
            "no_tenant_scope",
            `${name} is only available inside a signed-in account's request (403).`,
          ),
        );
      }
      const limits = cloudWebLimits(env);
      const limit = kind === "search" ? limits.searchesPerWindow : limits.fetchesPerWindow;
      const decision = (deps.limiter ?? sharedLimiter(limits)).take(uid, kind, limit);
      if (!decision.ok) {
        const retryAfterSeconds = Math.ceil(decision.retryAfterMs / 1000);
        if (decision.reason === "limiter_at_capacity") {
          return refuse(
            uid,
            new CloudWebToolError(
              503,
              "limiter_at_capacity",
              `${name} is temporarily unavailable (503): the service is at capacity. ` +
                `Retry in about ${retryAfterSeconds}s.`,
              retryAfterSeconds,
            ),
          );
        }
        return refuse(
          uid,
          new CloudWebToolError(
            429,
            "rate_limited",
            `rate limit reached (429): ${name} allows ${limit} call(s) per hour per account. ` +
              `Retry in about ${Math.max(1, Math.ceil(retryAfterSeconds / 60))} min. ` +
              `Do not retry in a loop — tell the user instead.`,
            retryAfterSeconds,
          ),
        );
      }
      try {
        const result = await base.execute(input, ctx);
        record(uid, "ok");
        return result;
      } catch (err) {
        record(uid, "error");
        throw err;
      }
    },
  };
  Object.defineProperty(governed, GOVERNED, { value: true, enumerable: true });
  return governed;
}

/**
 * The hosted instances of the two web tools: pinned-address egress, the hosted
 * outbound policy, the deadline, and the per-tenant limiter in front.
 */
export function createCloudWebTools(deps: CloudWebDependencies = {}): ToolDefinition[] {
  const limits = cloudWebLimits(deps.env ?? process.env);
  const transportDeps: SafeFetchDependencies = {
    ...(deps.lookup ? { lookup: deps.lookup } : {}),
    ...(deps.transport ? { transport: deps.transport } : {}),
  };
  const fetchTool = createWebFetchTool({
    ...transportDeps,
    policy: HOSTED_OUTBOUND_POLICY,
    timeoutMs: limits.timeoutMs,
  }) as unknown as ToolDefinition;
  const searchTool = createWebSearchTool({
    ...transportDeps,
    egress: "guarded",
    timeoutMs: limits.timeoutMs,
  }) as unknown as ToolDefinition;
  return [govern(fetchTool, "fetch", deps), govern(searchTool, "search", deps)];
}

/**
 * Swap any `web_search` / `web_fetch` in a cloud tool list for its governed
 * hosted instance — or drop both unless the operator has opted in.
 *
 * The incoming tool object is NOT wrapped: whatever was registered under those
 * names is replaced by an instance this module built, so the hosted policy
 * cannot be bypassed by handing in a differently-configured tool. Idempotent —
 * the cloud subset is applied more than once on the way to a request (cli.ts,
 * then capabilities.ts), and a second pass must not stack a second limiter.
 */
export function governCloudWebTools(
  tools: ToolDefinition[],
  deps: CloudWebDependencies = {},
): ToolDefinition[] {
  const enabled = cloudWebToolsEnabled(deps.env ?? process.env);
  let hosted: Map<string, ToolDefinition> | null = null;
  const out: ToolDefinition[] = [];
  for (const tool of tools) {
    if (!CLOUD_WEB_TOOL_NAMES.has(tool.name)) {
      out.push(tool);
      continue;
    }
    if (!enabled) continue;
    if (isGoverned(tool)) {
      out.push(tool);
      continue;
    }
    hosted ??= new Map(createCloudWebTools(deps).map((t) => [t.name, t]));
    out.push(hosted.get(tool.name)!);
  }
  return out;
}
