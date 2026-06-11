/**
 * Claude Code session monitor — Phase 1.
 *
 * Watches ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl for activity
 * from Claude Code's CLI / IDE clients. Emits an `update` event whenever
 * a session jsonl appears (new) or grows (message). LISA's web server
 * subscribes and broadcasts to /events SSE so the island widget and other
 * surfaces can render a "Claude is busy" indicator.
 *
 * ── PRIVACY CONTRACT ────────────────────────────────────────────────
 *
 *   This module NEVER reads the jsonl message contents. Only:
 *     - filename / directory name (= encoded cwd)
 *     - mtime
 *     - size in bytes
 *
 *   The user's prompts and Claude's replies stay in their files. We do
 *   not parse, log, or transmit them anywhere. Phase 2 might add an
 *   opt-in parser to detect "waiting for permission" semantics — that
 *   will be a separate, explicit decision.
 *
 * ── DEPENDENCIES ────────────────────────────────────────────────────
 *
 *   None added. Uses only `node:fs` (`fs.watch` with `recursive: true`
 *   works on macOS 10.5+ and Windows 10+ — perfect for our target).
 *
 * ── EVENT SEMANTICS ─────────────────────────────────────────────────
 *
 *   - "new"     — a session jsonl appeared we hadn't seen before
 *   - "message" — an existing session jsonl grew (debounced 200ms so a
 *                 fast token stream doesn't fire a flood)
 *   - (Phase 2) "waiting" / "completed" / "error" — needs jsonl parse
 *
 *   Active = mtime within ACTIVE_WINDOW_MS (30 min). listActive()
 *   returns sessions sorted newest-first, capped at MAX_LISTED.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { parseSessionState, parseSessionActivity, type ClaudeSessionState } from "./parser.js";
import type { SessionActivity } from "../types.js";

const CLAUDE_HOME       = process.env.CLAUDE_HOME ?? path.join(os.homedir(), ".claude");
const PROJECTS_DIR      = path.join(CLAUDE_HOME, "projects");
const DEBOUNCE_MS       = 200;
const ACTIVE_WINDOW_MS  = 30 * 60_000;
const MAX_LISTED        = 10;

/**
 * After Claude Code writes an `assistant` line with stop_reason=tool_use
 * the file stops growing until the tool returns. Crucially, Claude Code
 * does NOT log a system entry or subtype event for permission prompts —
 * the prompt lives entirely in the TUI and never touches the jsonl. So
 * on disk, a tool waiting for approval is INDISTINGUISHABLE from a tool
 * that is simply still running (npm test, a long Bash command, a slow
 * WebFetch).
 *
 * Because we can't tell those apart, staleness is never reported as
 * "waiting for permission" (doing so used to fire the advisor's urgent
 * "approve?" alarm for every auto-approved tool that ran >5s). Instead:
 *
 *   - working + tool_use, stale < TOOL_STALL_THRESHOLD_MS
 *       → stays "working" (the tool is presumably just running)
 *   - working + tool_use, stale ≥ TOOL_STALL_THRESHOLD_MS
 *       → waiting/"stalled on <tool>" — a soft hint only; the advisor's
 *         detectStuck escalates it to an ordinary notice after its own,
 *         much longer threshold, never to urgent
 *   - working + non-tool reason, stale ≥ IDLE_THRESHOLD_MS
 *       → waiting/"idle" (stream stalled, or the user cancelled)
 *
 * The "permission" reason survives only for the parser's EXPLICIT
 * signal (a system entry with a permission subtype — see parser.ts).
 */
const IDLE_THRESHOLD_MS = 5_000;
export const TOOL_STALL_THRESHOLD_MS = 60_000;

/**
 * Polling interval for the periodic re-evaluation that catches stale
 * tool_use sessions. The fs.watch event stream alone is insufficient
 * because the file isn't growing during the wait — no event fires —
 * so we periodically re-derive state for active sessions.
 */
const REPOLL_INTERVAL_MS = 3_000;

/**
 * One row in the in-memory session map. We hold mtime + size only —
 * never any jsonl content.
 */
export interface ClaudeSessionInfo {
  /** Encoded form, e.g. "-Users-oratis-Projects-Adex" */
  projectEncoded: string;
  /** Best-effort display label, e.g. "Adex" */
  projectLabel: string;
  /** UUID (.jsonl basename without extension) */
  sessionId: string;
  /** Last modification time (epoch ms) */
  lastMtime: number;
  /** Size in bytes (rough indicator of message volume) */
  size: number;
  /** Derived state — Phase 2; see parser.ts. */
  state: ClaudeSessionState;
  /** Short reason label for the derived state (debugging / tooltip). */
  stateReason: string;
  /**
   * Phase 3.5: cwd from Claude Code's top-level jsonl `.cwd` field.
   * Used by the island UI for "Open in Finder" / "Copy resume
   * command". Undefined if the jsonl didn't record it.
   */
  cwd?: string;
  /**
   * O2 (Tier-2): structural activity (tool names, files touched, last
   * command, error, tokens). Populated when visibility ≥ "activity".
   * Privacy: structural metadata only — never conversation content.
   */
  activity?: SessionActivity;
}

export interface ClaudeSessionUpdate {
  event: "new" | "message" | "state_changed";
  projectEncoded: string;
  projectLabel: string;
  sessionId: string;
  state: ClaudeSessionState;
  stateReason: string;
  cwd?: string;
  ts: string; // ISO
}

type Log = (msg: string) => void;

export class ClaudeCodeWatcher extends EventEmitter {
  private sessions = new Map<string, ClaudeSessionInfo>(); // key = full path
  private watcher: fs.FSWatcher | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private repollTimer: NodeJS.Timeout | null = null;
  private pendingChanges = new Map<string, NodeJS.Timeout>();
  private readonly log: Log;
  private readonly computeActivity: boolean;
  private started = false;

  constructor(opts: { log?: Log; computeActivity?: boolean } = {}) {
    super();
    this.log = opts.log ?? (() => {});
    // O2: only extract Tier-2 structural activity when asked (visibility ≥
    // "activity"). Default off preserves the metadata-only behavior.
    this.computeActivity = opts.computeActivity ?? false;
    this.setMaxListeners(32);
  }

  /** Begin watching. Idempotent. Survives ~/.claude/projects not existing yet. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.initialScan();
    await this.attachWatcher();
    this.startRepollLoop();
  }

  stop(): void {
    this.started = false;
    this.watcher?.close();
    this.watcher = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.repollTimer) clearInterval(this.repollTimer);
    this.repollTimer = null;
    for (const t of this.pendingChanges.values()) clearTimeout(t);
    this.pendingChanges.clear();
  }

  /** Sessions modified in the last 30 min, newest first, capped. */
  listActive(): ClaudeSessionInfo[] {
    const cutoff = Date.now() - ACTIVE_WINDOW_MS;
    return [...this.sessions.values()]
      .filter((s) => s.lastMtime >= cutoff)
      .sort((a, b) => b.lastMtime - a.lastMtime)
      .slice(0, MAX_LISTED);
  }

  // ── Internals ────────────────────────────────────────────────────

  private async initialScan(): Promise<void> {
    let projectDirs: string[];
    try {
      projectDirs = await fsp.readdir(PROJECTS_DIR);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") {
        this.log(`[claude-code] initial scan failed: ${e.message}`);
      }
      return;
    }

    for (const dir of projectDirs) {
      if (dir.startsWith(".")) continue;
      const projectPath = path.join(PROJECTS_DIR, dir);
      let sessionFiles: string[] = [];
      try {
        sessionFiles = await fsp.readdir(projectPath);
      } catch {
        continue;
      }
      for (const f of sessionFiles) {
        if (!f.endsWith(".jsonl")) continue;
        const full = path.join(projectPath, f);
        await this.recordExisting(full);
      }
    }
    this.log(`[claude-code] initial scan: ${this.sessions.size} session(s) seen`);
  }

  private async recordExisting(filePath: string): Promise<void> {
    try {
      const st = await fsp.stat(filePath);
      if (!st.isFile()) return;
      const parsed = await parseSessionState(filePath);
      const activity = this.computeActivity
        ? await parseSessionActivity(filePath)
        : undefined;
      const info = this.makeInfo(filePath, st.mtimeMs, st.size,
                                 parsed.state, parsed.reason, parsed.cwd, activity);
      this.sessions.set(filePath, info);
    } catch {
      // ignore — file disappeared between readdir and stat
    }
  }

  private async attachWatcher(): Promise<void> {
    try {
      await fsp.access(PROJECTS_DIR);
    } catch {
      // Directory doesn't exist (user hasn't run Claude Code yet).
      // Poll every 30s for its appearance; once it shows up, attach.
      this.scheduleRetry();
      return;
    }
    try {
      this.watcher = fs.watch(
        PROJECTS_DIR,
        { recursive: true, persistent: false },
        (_eventType, filename) => {
          if (filename) this.handleFsEvent(filename);
        },
      );
      this.watcher.on("error", (err) => {
        this.log(`[claude-code] watcher error: ${err.message}; will retry`);
        this.watcher?.close();
        this.watcher = null;
        this.scheduleRetry();
      });
      this.log(`[claude-code] watching ${PROJECTS_DIR}`);
    } catch (err) {
      this.log(`[claude-code] failed to attach: ${(err as Error).message}; retrying`);
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer || !this.started) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.attachWatcher();
    }, 30_000);
  }

  /**
   * fs.watch fires the relative path of the changed entry. We debounce
   * to coalesce rapid streaming writes into one `message` event per
   * burst.
   */
  private handleFsEvent(filename: string): void {
    if (!filename.endsWith(".jsonl")) return;
    const full = path.join(PROJECTS_DIR, filename);
    const existing = this.pendingChanges.get(full);
    if (existing) clearTimeout(existing);
    this.pendingChanges.set(
      full,
      setTimeout(() => {
        this.pendingChanges.delete(full);
        void this.diff(full);
      }, DEBOUNCE_MS),
    );
  }

  private async diff(fullPath: string): Promise<void> {
    let st: fs.Stats;
    try {
      st = await fsp.stat(fullPath);
    } catch {
      // file was deleted — drop from map silently (no `ended` event in Phase 1)
      this.sessions.delete(fullPath);
      return;
    }
    if (!st.isFile()) return;

    const prev = this.sessions.get(fullPath);
    const parsed = await parseSessionState(fullPath);
    const activity = this.computeActivity
      ? await parseSessionActivity(fullPath)
      : undefined;
    const info = this.makeInfo(fullPath, st.mtimeMs, st.size,
                               parsed.state, parsed.reason, parsed.cwd, activity);
    this.sessions.set(fullPath, info);

    if (!prev) {
      this.emitUpdate("new", info);
      return;
    }
    const grew = st.size !== prev.size || st.mtimeMs !== prev.lastMtime;
    const stateChanged = prev.state !== info.state;
    if (grew) {
      // A "message" event implicitly reports the new state too.
      this.emitUpdate("message", info);
    } else if (stateChanged) {
      // Rare path: file mtime/size unchanged but parse derived a
      // different state. Emit a state-only event so the UI can react.
      this.emitUpdate("state_changed", info);
    }
  }

  private emitUpdate(event: "new" | "message" | "state_changed", info: ClaudeSessionInfo): void {
    const payload: ClaudeSessionUpdate = {
      event,
      projectEncoded: info.projectEncoded,
      projectLabel: info.projectLabel,
      sessionId: info.sessionId,
      state: info.state,
      stateReason: info.stateReason,
      cwd: info.cwd,
      ts: new Date().toISOString(),
    };
    this.emit("update", payload);
  }

  private makeInfo(
    filePath: string,
    mtimeMs: number,
    size: number,
    state: ClaudeSessionState,
    stateReason: string,
    cwd: string | undefined,
    activity?: SessionActivity,
  ): ClaudeSessionInfo {
    const sessionId = path.basename(filePath, ".jsonl");
    const projectEncoded = path.basename(path.dirname(filePath));
    const derived = applyStaleness(state, stateReason, Date.now() - mtimeMs, activity);
    return {
      projectEncoded,
      projectLabel: decodeProjectLabel(projectEncoded),
      sessionId,
      lastMtime: mtimeMs,
      size,
      state: derived.state,
      stateReason: derived.stateReason,
      cwd,
      activity: derived.activity,
    };
  }

  /**
   * Periodic re-evaluation of active sessions' state. The fs.watch
   * stream only fires when the file changes — but the very condition
   * we want to detect (a session going idle, a tool stalling) is "the
   * file STOPPED changing". So we sweep every few seconds: for each
   * session with a recent mtime, re-stat + re-parse + emit
   * `state_changed` if the derived state has flipped.
   *
   * Cheap: stat is O(1), parser reads only the file's tail.
   */
  private startRepollLoop(): void {
    if (this.repollTimer) return;
    this.repollTimer = setInterval(() => {
      void this.repollActive();
    }, REPOLL_INTERVAL_MS);
    // Don't keep the process alive purely for this poll — the HTTP
    // server's listening sockets are the real lifecycle holders.
    if (this.repollTimer.unref) this.repollTimer.unref();
  }

  private async repollActive(): Promise<void> {
    const cutoff = Date.now() - ACTIVE_WINDOW_MS;
    const candidates = [...this.sessions.entries()]
      .filter(([, info]) => info.lastMtime >= cutoff);
    for (const [filePath, prev] of candidates) {
      let st: fs.Stats;
      try {
        st = await fsp.stat(filePath);
      } catch {
        continue; // file gone — let the fs.watch flow handle removal
      }
      if (!st.isFile()) continue;
      const parsed = await parseSessionState(filePath);
      // Carry over the previously parsed activity: the file hasn't
      // grown (that's why we're sweeping), so re-extracting would be
      // wasted I/O — and dropping it would lose the tool names that
      // label a stall ("stalled on <tool>").
      const info = this.makeInfo(filePath, st.mtimeMs, st.size,
                                 parsed.state, parsed.reason, parsed.cwd,
                                 prev.activity);
      // No file growth here — only re-emit when the DERIVED state
      // changed (working → waiting after staleness).
      if (info.state !== prev.state || info.stateReason !== prev.stateReason) {
        this.sessions.set(filePath, info);
        this.emitUpdate("state_changed", info);
      }
    }
  }
}

/**
 * Staleness heuristic, applied on top of the parsed (on-disk) state.
 * Pure — the unit under test in watcher.test.ts.
 *
 * A "working" session whose jsonl has stopped growing means one of:
 *
 *   - tool_use + stale  → a tool call is in flight. Usually it's just a
 *                          slow tool (npm test, a long Bash command) —
 *                          and Claude Code writes nothing to the jsonl
 *                          for permission prompts, so "still running"
 *                          and "waiting for approval" look identical on
 *                          disk. Short stalls stay "working"; only a
 *                          markedly long one flips to a soft
 *                          waiting/"stalled on <tool>" that detectStuck
 *                          may later escalate to an ordinary notice —
 *                          never the urgent "approve?" path.
 *   - assistant + stale → API stream stalled or Claude is mid-thinking
 *                          on a hard turn
 *   - user + stale      → tool result came back but Claude never wrote
 *                          the follow-up — usually means the user
 *                          cancelled Claude Code
 *
 * The last two flip to waiting/"idle" — honest about what we know.
 *
 * `pendingPermission` is attached ONLY when the parser saw an explicit
 * permission entry (reason "permission") — never inferred from
 * staleness. A pendingPermission baked into a carried-over activity
 * snapshot is stripped once the reason no longer says permission.
 */
export function applyStaleness(
  state: ClaudeSessionState,
  stateReason: string,
  ageMs: number,
  activity?: SessionActivity,
): { state: ClaudeSessionState; stateReason: string; activity?: SessionActivity } {
  let finalState = state;
  let finalReason = stateReason;
  if (state === "working" && stateReason === "tool_use") {
    if (ageMs >= TOOL_STALL_THRESHOLD_MS) {
      const tools = activity?.lastTools ?? [];
      const lastTool = tools[tools.length - 1];
      finalState = "waiting";
      finalReason = lastTool ? `stalled on ${lastTool}` : "stalled";
    }
  } else if (state === "working" && ageMs >= IDLE_THRESHOLD_MS) {
    finalState = "waiting";
    finalReason = "idle";
  }
  let finalActivity = activity;
  if (finalActivity) {
    if (finalReason === "permission" && finalActivity.lastTools.length) {
      finalActivity = {
        ...finalActivity,
        pendingPermission: finalActivity.lastTools[finalActivity.lastTools.length - 1],
      };
    } else if (finalActivity.pendingPermission) {
      finalActivity = { ...finalActivity, pendingPermission: undefined };
    }
  }
  return { state: finalState, stateReason: finalReason, activity: finalActivity };
}

/**
 * `~/.claude/projects/-Users-oratis-Projects-Adex` → "Adex".
 * Heuristic: strip a leading dash, replace remaining dashes with slashes,
 * take the basename. Falls back to the raw encoded form if the result
 * looks broken (no `/`, suspiciously empty).
 */
export function decodeProjectLabel(encoded: string): string {
  if (!encoded.startsWith("-")) return encoded;
  const asPath = "/" + encoded.slice(1).replace(/-/g, "/");
  const base = path.basename(asPath);
  if (!base || base === "/") return encoded;
  return base;
}

export const CLAUDE_PROJECTS_DIR = PROJECTS_DIR;
