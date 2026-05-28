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

const CLAUDE_HOME       = process.env.CLAUDE_HOME ?? path.join(os.homedir(), ".claude");
const PROJECTS_DIR      = path.join(CLAUDE_HOME, "projects");
const DEBOUNCE_MS       = 200;
const ACTIVE_WINDOW_MS  = 30 * 60_000;
const MAX_LISTED        = 10;

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
}

export interface ClaudeSessionUpdate {
  event: "new" | "message";
  projectEncoded: string;
  projectLabel: string;
  sessionId: string;
  ts: string; // ISO
}

type Log = (msg: string) => void;

export class ClaudeCodeWatcher extends EventEmitter {
  private sessions = new Map<string, ClaudeSessionInfo>(); // key = full path
  private watcher: fs.FSWatcher | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private pendingChanges = new Map<string, NodeJS.Timeout>();
  private readonly log: Log;
  private started = false;

  constructor(opts: { log?: Log } = {}) {
    super();
    this.log = opts.log ?? (() => {});
    this.setMaxListeners(32);
  }

  /** Begin watching. Idempotent. Survives ~/.claude/projects not existing yet. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.initialScan();
    await this.attachWatcher();
  }

  stop(): void {
    this.started = false;
    this.watcher?.close();
    this.watcher = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
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
      const info = this.makeInfo(filePath, st.mtimeMs, st.size);
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
    const info = this.makeInfo(fullPath, st.mtimeMs, st.size);
    this.sessions.set(fullPath, info);

    if (!prev) {
      this.emitUpdate("new", info);
      return;
    }
    if (st.size !== prev.size || st.mtimeMs !== prev.lastMtime) {
      this.emitUpdate("message", info);
    }
  }

  private emitUpdate(event: "new" | "message", info: ClaudeSessionInfo): void {
    const payload: ClaudeSessionUpdate = {
      event,
      projectEncoded: info.projectEncoded,
      projectLabel: info.projectLabel,
      sessionId: info.sessionId,
      ts: new Date().toISOString(),
    };
    this.emit("update", payload);
  }

  private makeInfo(filePath: string, mtimeMs: number, size: number): ClaudeSessionInfo {
    const sessionId = path.basename(filePath, ".jsonl");
    const projectEncoded = path.basename(path.dirname(filePath));
    return {
      projectEncoded,
      projectLabel: decodeProjectLabel(projectEncoded),
      sessionId,
      lastMtime: mtimeMs,
      size,
    };
  }
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
