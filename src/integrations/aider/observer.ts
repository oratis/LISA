/**
 * Aider observer (O4 — local CLI agent, per-project history files).
 *
 * Unlike Claude Code / Codex / OpenCode, Aider has NO central session store —
 * it writes a Markdown transcript `.aider.chat.history.md` into the directory
 * it runs in. So there is nothing global to discover: this adapter scans the
 * configured `watchRoots` (the project dirs you run Aider in) for that file.
 * (The `watchRoots` field on AgentIntegrationConfig was reserved for exactly
 * this.) With no watchRoots it observes nothing.
 *
 * `.aider.chat.history.md` shape (verified against aider 0.86):
 *   # aider chat started at 2026-06-02 00:50:26
 *   > …aider info / tool / result lines (prefixed "> ")…
 *   #### the user's prompt              ← user turns are "#### "
 *   …assistant prose (unprefixed)…
 * State is a tolerant heuristic from the tail (aider writes no state markers):
 *   - an error marker after the last user turn       → error
 *   - assistant content after the last user turn     → waiting (it replied)
 *   - a user turn with nothing after it yet           → working
 * The active-window (file mtime) drops stale transcripts.
 *
 * PRIVACY: only the derived state + the project dir basename + mtime are
 * surfaced — never the transcript text.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { registerIntegration } from "../registry.js";
import type {
  AgentIntegrationConfig,
  AgentObserver,
  AgentSession,
  AgentSessionState,
} from "../types.js";

const HISTORY_FILE = ".aider.chat.history.md";
const ACTIVE_WINDOW_MS = 30 * 60_000; // 30m
const MAX_LISTED = 10;
const DEBOUNCE_MS = 300;
const TAIL_BYTES = 16 * 1024;
const MAX_DEPTH = 3;

const ERROR_RE = /(litellm\.\w*error|traceback \(most recent call last\)|^> .*error:|exception:)/im;

/** Tolerant state derivation from a chat-history tail. Pure — the unit under test. */
export function parseAiderState(tail: string): {
  state: AgentSessionState;
  reason: string;
} {
  const lines = tail.split("\n");
  let lastUser = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.startsWith("#### ")) {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) return { state: "unknown", reason: "no-turn" };

  const after = lines.slice(lastUser + 1);
  if (after.some((l) => ERROR_RE.test(l))) return { state: "error", reason: "error" };

  // Assistant prose (unprefixed, non-empty) or any "> " result line after the
  // user's last turn means aider responded → waiting; otherwise still working.
  const replied = after.some((l) => {
    const t = l.trim();
    return t.length > 0 && !t.startsWith("####");
  });
  return replied
    ? { state: "waiting", reason: "assistant" }
    : { state: "working", reason: "user" };
}

/** Recursively collect .aider.chat.history.md under a root (bounded depth). */
export async function walkHistories(root: string, maxDepth = MAX_DEPTH): Promise<string[]> {
  const out: string[] = [];
  async function rec(dir: string, depth: number): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isFile() && e.name === HISTORY_FILE) out.push(path.join(dir, e.name));
      else if (e.isDirectory() && depth < maxDepth && !e.name.startsWith(".") && e.name !== "node_modules") {
        await rec(path.join(dir, e.name), depth + 1);
      }
    }
  }
  await rec(root, 0);
  return out;
}

async function readTail(file: string): Promise<string> {
  const st = await fsp.stat(file);
  if (st.size === 0) return "";
  const fd = await fsp.open(file, "r");
  try {
    const len = Math.min(TAIL_BYTES, st.size);
    const buf = Buffer.alloc(len);
    await fd.read(buf, 0, len, st.size - len);
    return buf.toString("utf8");
  } finally {
    await fd.close();
  }
}

interface AiderSessionInfo {
  sessionId: string;
  project: string;
  cwd: string;
  lastMtime: number;
  state: AgentSessionState;
  stateReason: string;
}

export class AiderObserver extends EventEmitter implements AgentObserver {
  readonly agent = "aider";
  private roots: string[];
  private sessions = new Map<string, AiderSessionInfo>();
  private watchers: fs.FSWatcher[] = [];
  private pending = new Map<string, NodeJS.Timeout>();
  private emitFn: ((s: AgentSession) => void) | null = null;

  constructor(cfg: AgentIntegrationConfig) {
    super();
    const raw = Array.isArray(cfg.watchRoots) ? cfg.watchRoots : [];
    this.roots = raw
      .filter((r): r is string => typeof r === "string")
      .map((r) => r.replace(/^~/, os.homedir()));
  }

  async start(emit: (s: AgentSession) => void): Promise<void> {
    this.emitFn = emit;
    for (const root of this.roots) {
      for (const f of await walkHistories(root)) await this.record(f);
      this.attach(root);
    }
  }

  list(): AgentSession[] {
    const cutoff = Date.now() - ACTIVE_WINDOW_MS;
    return [...this.sessions.values()]
      .filter((s) => s.lastMtime >= cutoff)
      .sort((a, b) => b.lastMtime - a.lastMtime)
      .slice(0, MAX_LISTED)
      .map(toAgentSession);
  }

  async stop(): Promise<void> {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  private attach(root: string): void {
    try {
      const w = fs.watch(root, { recursive: true, persistent: false }, (_e, filename) => {
        if (!filename || path.basename(filename) !== HISTORY_FILE) return;
        const full = path.join(root, filename);
        const prev = this.pending.get(full);
        if (prev) clearTimeout(prev);
        this.pending.set(
          full,
          setTimeout(() => {
            this.pending.delete(full);
            void this.record(full).then(() => {
              const info = this.sessions.get(full);
              if (info && this.emitFn) this.emitFn(toAgentSession(info));
            });
          }, DEBOUNCE_MS),
        );
      });
      w.on("error", () => w.close());
      this.watchers.push(w);
    } catch {
      // root unwatchable → no-op
    }
  }

  private async record(full: string): Promise<void> {
    try {
      const st = await fsp.stat(full);
      if (!st.isFile()) return;
      const { state, reason } = parseAiderState(await readTail(full));
      const cwd = path.dirname(full);
      this.sessions.set(full, {
        sessionId: full,
        project: path.basename(cwd),
        cwd,
        lastMtime: st.mtimeMs,
        state,
        stateReason: reason,
      });
    } catch {
      this.sessions.delete(full);
    }
  }
}

function toAgentSession(i: AiderSessionInfo): AgentSession {
  return {
    agent: "aider",
    sessionId: i.sessionId,
    project: i.project,
    cwd: i.cwd,
    state: i.state,
    stateReason: i.stateReason,
    lastMtime: i.lastMtime,
  };
}

registerIntegration("aider", (cfg) => new AiderObserver(cfg));
