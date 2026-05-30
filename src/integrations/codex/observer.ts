/**
 * OpenAI Codex CLI observer — proves the integration registry generalizes
 * beyond Claude Code.
 *
 * Codex persists each session as JSONL at
 *   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl   (CODEX_HOME ~ ~/.codex)
 * — the same file-tailing shape as Claude Code, so this adapter mirrors that
 * watcher's structure: scan + fs.watch the sessions tree, derive state from
 * each file's tail, normalize to AgentSession.
 *
 * PRIVACY: identical contract to claude-code — only structural metadata
 * (entry `type`/`role`, error flags, file mtime). Never message content.
 *
 * NOTE: Codex's exact rollout schema varies by version; the state parse is
 * deliberately tolerant (unknown shapes → "unknown") and the integration is
 * DISABLED by default (opt in via ~/.lisa/agents.json). It graceful-no-ops
 * when $CODEX_HOME/sessions is absent.
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

const ACTIVE_WINDOW_MS = 30 * 60_000;
const MAX_LISTED = 10;
const DEBOUNCE_MS = 300;
const TAIL_BYTES = 32 * 1024;

interface CodexSessionInfo {
  sessionId: string;
  project: string;
  cwd?: string;
  lastMtime: number;
  state: AgentSessionState;
  stateReason: string;
}

export class CodexObserver extends EventEmitter implements AgentObserver {
  readonly agent = "codex";
  private sessionsRoot: string;
  private sessions = new Map<string, CodexSessionInfo>();
  private watcher: fs.FSWatcher | null = null;
  private pending = new Map<string, NodeJS.Timeout>();
  private emitFn: ((s: AgentSession) => void) | null = null;

  constructor(cfg: AgentIntegrationConfig) {
    super();
    const home = cfg.home
      ? (cfg.home as string).replace(/^~/, os.homedir())
      : process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
    this.sessionsRoot = path.join(home, "sessions");
  }

  async start(emit: (s: AgentSession) => void): Promise<void> {
    this.emitFn = emit;
    await this.scan();
    this.attach();
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
    this.watcher?.close();
    this.watcher = null;
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  // ── internals ──
  private async scan(): Promise<void> {
    const files = await walkRollouts(this.sessionsRoot);
    for (const f of files) await this.record(f);
  }

  private attach(): void {
    try {
      this.watcher = fs.watch(
        this.sessionsRoot,
        { recursive: true, persistent: false },
        (_e, filename) => {
          if (!filename) return;
          const base = path.basename(filename);
          if (!base.startsWith("rollout-") || !base.endsWith(".jsonl")) return;
          const full = path.join(this.sessionsRoot, filename);
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
        },
      );
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      // sessions dir absent / unwatchable → graceful no-op (Codex not installed)
    }
  }

  private async record(full: string): Promise<void> {
    try {
      const st = await fsp.stat(full);
      if (!st.isFile()) return;
      const { state, reason, cwd } = await parseCodexState(full);
      this.sessions.set(full, {
        sessionId: path.basename(full, ".jsonl").replace(/^rollout-/, ""),
        project: cwd ? path.basename(cwd) : path.basename(path.dirname(full)),
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

function toAgentSession(i: CodexSessionInfo): AgentSession {
  return {
    agent: "codex",
    sessionId: i.sessionId,
    project: i.project,
    cwd: i.cwd,
    state: i.state,
    stateReason: i.stateReason,
    lastMtime: i.lastMtime,
  };
}

/** Recursively collect rollout-*.jsonl under root. Empty array if absent. */
export async function walkRollouts(root: string): Promise<string[]> {
  const out: string[] = [];
  async function rec(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await rec(full);
      else if (e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) out.push(full);
    }
  }
  await rec(root);
  return out;
}

/**
 * Tolerant state derivation from a Codex rollout tail. Codex schema differs
 * by version; we look for the last entry's role/type and any error flag.
 * Unknown shapes → "unknown". Structural fields only.
 */
export async function parseCodexState(
  filePath: string,
): Promise<{ state: AgentSessionState; reason: string; cwd?: string }> {
  let tail: string;
  let size: number;
  try {
    const st = await fsp.stat(filePath);
    size = st.size;
    if (size === 0) return { state: "unknown", reason: "empty" };
    const fd = await fsp.open(filePath, "r");
    try {
      const len = Math.min(TAIL_BYTES, size);
      const buf = Buffer.alloc(len);
      await fd.read(buf, 0, len, size - len);
      tail = buf.toString("utf8");
    } finally {
      await fd.close();
    }
  } catch {
    return { state: "unknown", reason: "read-failed" };
  }

  const lines = tail.split("\n").filter(Boolean);
  if (size > TAIL_BYTES && lines.length) lines.shift();

  let cwd: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(lines[i]!) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!cwd && typeof e.cwd === "string") cwd = e.cwd;
    if (e.is_error === true || e.error === true) return { state: "error", reason: "is_error", cwd };
    const type = typeof e.type === "string" ? e.type : undefined;
    const role =
      typeof e.role === "string"
        ? e.role
        : typeof (e.message as { role?: unknown })?.role === "string"
          ? ((e.message as { role: string }).role)
          : undefined;
    // Heuristic: last meaningful entry from the assistant → it just spoke
    // (waiting for the user); from the user / a tool call → working.
    if (role === "assistant" || type === "assistant" || type === "response") {
      return { state: "waiting", reason: "assistant", cwd };
    }
    if (role === "user" || type === "user" || type === "function_call" || type === "tool_use") {
      return { state: "working", reason: type ?? role ?? "user", cwd };
    }
  }
  return { state: "unknown", reason: "no-decision", cwd };
}

registerIntegration("codex", (cfg) => new CodexObserver(cfg));
