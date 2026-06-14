/**
 * Screen sense source (PLAN_SENSE S2-screen) — the user's foreground context as
 * an ambient signal: WHICH app is in front, emitted only when it changes.
 *
 * Deliberately the cheap, low-sensitivity slice of S2-screen: app NAME (and an
 * optional, blacklist-checked + PII-redacted window title). It does NOT capture
 * screen pixels — there is no screenshot here; raw screen content never enters a
 * SenseEvent. (The optional low-frequency screenshot→model path is a follow-up
 * that reuses the existing screen-advisor, and would persist nothing.)
 *
 * Consent + privacy (FOUNDATIONS §1):
 *   - captures nothing unless `screen` is granted; re-checks every tick so a
 *     revoke takes effect within one interval (and resets state).
 *   - a blacklisted foreground app (password manager / bank) → whole frame
 *     skipped: no event, and prev stays put so the app is invisible to the
 *     timeline (switching THROUGH it leaves no trace).
 *   - a window title is dropped if it looks like a secret path, else PII-redacted.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isGranted } from "../consent/store.js";
import { isBlacklistedApp, isBlacklistedPath, redactPII } from "../consent/blacklist.js";
import type { SenseEvent, SenseSource } from "./types.js";

const pexec = promisify(execFile);
const DEFAULT_INTERVAL_MS = 15_000;

/** Probes the current foreground app (+ optional title). Injectable for tests. */
export type ForegroundProbe = () => Promise<{ app?: string; title?: string }>;

/** macOS foreground app via System Events. {} off-darwin / on any failure. */
export const defaultForegroundProbe: ForegroundProbe = async () => {
  if (process.platform !== "darwin") return {};
  try {
    const { stdout } = await pexec(
      "osascript",
      ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true'],
      { timeout: 3_000 },
    );
    return { app: stdout.trim() || undefined };
  } catch {
    return {}; // no permission / not darwin / timeout → capture nothing
  }
};

/**
 * Decide whether a foreground probe should produce an event. Pure — the privacy-
 * critical unit. Returns null for: no app, a blacklisted app (skip frame), or no
 * change since prevApp. A surfaced title is secret-path-dropped + PII-redacted.
 */
export function shouldEmitForeground(
  prevApp: string | undefined,
  cur: { app?: string; title?: string },
  now: number,
  appBlacklist: string[] = [],
): SenseEvent | null {
  const app = cur.app;
  if (!app) return null;
  if (isBlacklistedApp(app, appBlacklist)) return null; // skip whole frame
  if (app === prevApp) return null; // unchanged → nothing to record
  let title = cur.title;
  if (title) {
    title = isBlacklistedPath(title) ? undefined : redactPII(title);
  }
  return {
    signal: "screen",
    kind: "foreground-app",
    app,
    ...(title ? { title } : {}),
    summary: "switched to " + app,
    ts: now,
  };
}

export interface ScreenSourceOptions {
  probe?: ForegroundProbe;
  intervalMs?: number;
  /** Extra app-name blacklist entries merged on top of the defaults. */
  appBlacklist?: string[];
  now?: () => number;
  /** Injectable consent check (tests); defaults to the real consent store. */
  granted?: () => boolean;
}

export class ScreenSource implements SenseSource {
  readonly signal = "screen";
  private timer: NodeJS.Timeout | null = null;
  private emitFn: ((e: SenseEvent) => void) | null = null;
  private prevApp: string | undefined;
  private readonly probe: ForegroundProbe;
  private readonly intervalMs: number;
  private readonly appBlacklist: string[];
  private readonly now: () => number;
  private readonly granted: () => boolean;

  constructor(opts: ScreenSourceOptions = {}) {
    this.probe = opts.probe ?? defaultForegroundProbe;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.appBlacklist = opts.appBlacklist ?? [];
    this.now = opts.now ?? Date.now;
    this.granted = opts.granted ?? (() => isGranted("screen"));
  }

  async start(emit: (e: SenseEvent) => void): Promise<void> {
    this.emitFn = emit;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  /** One capture cycle. Exposed for deterministic tests. */
  async tick(): Promise<void> {
    if (!this.granted()) {
      this.prevApp = undefined; // revoked → stop emitting + forget context
      return;
    }
    const cur = await this.probe();
    const ev = shouldEmitForeground(this.prevApp, cur, this.now(), this.appBlacklist);
    // Track prev only for a present, non-blacklisted app (blacklisted frames
    // leave prev untouched so they never appear in the timeline).
    if (cur.app && !isBlacklistedApp(cur.app, this.appBlacklist)) this.prevApp = cur.app;
    if (ev && this.emitFn) this.emitFn(ev);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.emitFn = null;
  }
}
