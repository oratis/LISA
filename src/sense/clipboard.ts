/**
 * Clipboard metadata sense source (PLAN_SENSE S4) — consent-gated observation
 * of NSPasteboard change counts + foreground app category without ever reading
 * or persisting clipboard contents (`storeContent: false` invariant).
 *
 * Privacy / security boundaries (FOUNDATIONS §1):
 *   - Unconditionally calls `granted()` on every tick; when ungranted or revoked,
 *     no-ops immediately and forgets the tracked `lastChangeCount`.
 *   - First granted tick records a baseline `changeCount` without emitting, so
 *     copies made prior to enabling consent are never attributed.
 *   - Blacklisted apps (1Password, Keychain, banks, etc.) suppress event emission
 *     while still advancing `lastChangeCount`, preventing delayed attribution when
 *     switching away to another app.
 *   - Never invokes external clipboard-dumping commands or reads raw item payloads
 *     from NSPasteboard.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isGranted } from "../consent/store.js";
import { isBlacklistedApp, isBlacklistedPath, redactPII } from "../consent/blacklist.js";
import { defaultForegroundProbe, type ForegroundProbe } from "./screen.js";
import type { SenseEvent, SenseSource } from "./types.js";

const pexec = promisify(execFile);
const DEFAULT_INTERVAL_MS = 10_000;
const PROBE_TIMEOUT_MS = 2_500;

export type ClipboardContentKind = "text" | "url" | "image" | "file" | "unknown";

export interface ClipboardProbeResult {
  changeCount?: number;
  types?: string[];
  app?: string;
}

export type ClipboardProbe = () => Promise<ClipboardProbeResult>;

/** Map macOS NSPasteboard UTI type names to a coarse structural category. */
export function classifyClipboardKind(types: readonly string[] = []): ClipboardContentKind {
  const lower = types.map((t) => t.toLowerCase());
  if (lower.some((t) => t.includes("file-url") || t === "nsfilenamespboardtype")) {
    return "file";
  }
  if (lower.some((t) => t === "public.url" || t.includes("url-name"))) {
    return "url";
  }
  if (
    lower.some(
      (t) => t.includes("image") || t.includes("png") || t.includes("tiff") || t.includes("jpeg"),
    )
  ) {
    return "image";
  }
  if (
    lower.some(
      (t) => t.includes("text") || t.includes("string") || t.includes("rtf") || t.includes("html"),
    )
  ) {
    return "text";
  }
  return "unknown";
}

/**
 * macOS clipboard metadata probe using JXA `NSPasteboard.generalPasteboard`
 * `changeCount` + `types` ONLY (never reads raw clipboard payloads).
 */
export function createDefaultClipboardProbe(
  foregroundProbe: ForegroundProbe = defaultForegroundProbe,
): ClipboardProbe {
  return async () => {
    if (process.platform !== "darwin") return {};
    try {
      const [{ stdout }, fg] = await Promise.all([
        pexec(
          "osascript",
          [
            "-l",
            "JavaScript",
            "-e",
            [
              'ObjC.import("AppKit");',
              "const pb = $.NSPasteboard.generalPasteboard;",
              "const rawTypes = ObjC.unwrap(pb.types) || [];",
              "const types = [];",
              "for (let i = 0; i < Math.min(rawTypes.length, 12); i++) {",
              "  const t = ObjC.unwrap(rawTypes[i]);",
              '  if (typeof t === "string") types.push(t);',
              "}",
              "JSON.stringify({ changeCount: Number(pb.changeCount), types });",
            ].join(" "),
          ],
          { timeout: PROBE_TIMEOUT_MS },
        ),
        foregroundProbe().catch((): { app?: string } => ({})),
      ]);
      const parsed = JSON.parse(stdout.trim() || "{}") as {
        changeCount?: unknown;
        types?: unknown;
      };
      const changeCount =
        typeof parsed.changeCount === "number" && Number.isFinite(parsed.changeCount)
          ? parsed.changeCount
          : undefined;
      const types = Array.isArray(parsed.types)
        ? parsed.types.filter((t): t is string => typeof t === "string").slice(0, 12)
        : undefined;
      return {
        changeCount,
        types,
        ...(fg.app ? { app: fg.app } : {}),
      };
    } catch {
      return {};
    }
  };
}

/**
 * Pure privacy-critical transition evaluator for a single clipboard tick.
 * Advances `changeCount` even on blacklisted frames so exiting a password
 * manager cannot falsely attribute the earlier copy to the next app.
 */
export function evaluateClipboardTick(
  prevChangeCount: number | undefined,
  cur: ClipboardProbeResult,
  now: number,
  appBlacklist: readonly string[] = [],
): { nextChangeCount: number | undefined; event: SenseEvent | null } {
  if (typeof cur.changeCount !== "number" || !Number.isFinite(cur.changeCount)) {
    return { nextChangeCount: prevChangeCount, event: null };
  }
  const curCount = cur.changeCount;
  if (prevChangeCount === undefined) {
    // Baseline capture on first granted tick: emit nothing.
    return { nextChangeCount: curCount, event: null };
  }
  if (curCount === prevChangeCount) {
    return { nextChangeCount: prevChangeCount, event: null };
  }

  // Change occurred; advance tracked count regardless of blacklist outcome.
  if (cur.app && isBlacklistedApp(cur.app, [...appBlacklist])) {
    return { nextChangeCount: curCount, event: null };
  }

  let safeApp = cur.app?.trim() || undefined;
  if (safeApp) {
    safeApp = isBlacklistedPath(safeApp) ? undefined : redactPII(safeApp);
  }
  const kind = classifyClipboardKind(cur.types);
  return {
    nextChangeCount: curCount,
    event: {
      signal: "clipboard",
      kind: "clipboard-change",
      ...(safeApp ? { app: safeApp } : {}),
      summary: safeApp ? `clipboard ${kind} updated in ${safeApp}` : `clipboard ${kind} updated`,
      ts: now,
    },
  };
}

export interface ClipboardSourceOptions {
  probe?: ClipboardProbe;
  intervalMs?: number;
  appBlacklist?: string[];
  now?: () => number;
  granted?: () => boolean;
}

export class ClipboardSource implements SenseSource {
  readonly signal = "clipboard";
  private timer: NodeJS.Timeout | null = null;
  private emitFn: ((e: SenseEvent) => void) | null = null;
  private lastChangeCount: number | undefined;
  private ticking = false;
  private readonly probe: ClipboardProbe;
  private readonly intervalMs: number;
  private readonly appBlacklist: string[];
  private readonly now: () => number;
  private readonly granted: () => boolean;

  constructor(opts: ClipboardSourceOptions = {}) {
    this.probe = opts.probe ?? createDefaultClipboardProbe();
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.appBlacklist = opts.appBlacklist ?? [];
    this.now = opts.now ?? Date.now;
    this.granted = opts.granted ?? (() => isGranted("clipboard"));
  }

  async start(emit: (e: SenseEvent) => void): Promise<void> {
    this.emitFn = emit;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  /** One poll cycle. Exposed for deterministic testing. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    if (!this.granted()) {
      this.lastChangeCount = undefined;
      return;
    }
    this.ticking = true;
    try {
      const cur = await this.probe();
      if (!this.granted()) {
        this.lastChangeCount = undefined;
        return;
      }
      const { nextChangeCount, event } = evaluateClipboardTick(
        this.lastChangeCount,
        cur,
        this.now(),
        this.appBlacklist,
      );
      this.lastChangeCount = nextChangeCount;
      if (event && this.emitFn) {
        this.emitFn(event);
      }
    } finally {
      this.ticking = false;
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.emitFn = null;
    this.lastChangeCount = undefined;
  }
}
