/**
 * OpenCode observer (O3 — local CLI agent, SQLite-backed).
 *
 * Recent OpenCode (≥ ~1.15) stores sessions in a SQLite database at
 *   $XDG_DATA_HOME/opencode/opencode.db   (≈ ~/.local/share/opencode/opencode.db)
 * — not flat JSONL like Claude Code / Codex. So instead of tailing files this
 * adapter POLLS the DB (read-only) via the system `sqlite3` CLI, which keeps us
 * dependency-free (no sqlite npm package, and `node:sqlite` isn't available on
 * the Node 20/22 we support).
 *
 * State is derived from the `session` row plus its newest `message`:
 *   - session.time_archived set      → done
 *   - session.time_compacting set    → working (compacting context)
 *   - latest message has `error`     → error
 *   - latest message role=assistant + time.completed set → waiting (it replied)
 *   - latest message role=assistant, not completed       → working (mid-turn)
 *   - latest message role=user                           → working (its turn)
 *
 * PRIVACY: only structural fields — session title, directory, token counts,
 * message role/role-timing/error flag. Never message text or tool arguments.
 * DISABLED by default; opt in via ~/.lisa/agents.json. Graceful no-op if
 * `sqlite3` or the DB is absent (every read failure → empty, never throws).
 */

import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { registerIntegration } from "../registry.js";
import type {
  AgentIntegrationConfig,
  AgentObserver,
  AgentSession,
  AgentSessionState,
} from "../types.js";

const pexec = promisify(execFile);

const POLL_MS_DEFAULT = 60_000;
const ACTIVE_WINDOW_MS_DEFAULT = 6 * 60 * 60_000; // 6h
const MAX_LISTED = 12;

/** A row of the adapter's query — session columns + the newest message's data. */
export interface OpencodeRow {
  id: string;
  directory?: string | null;
  title?: string | null;
  agent?: string | null;
  time_updated?: number | null;
  time_archived?: number | null;
  time_compacting?: number | null;
  tokens_input?: number | null;
  tokens_output?: number | null;
  /** JSON string of the latest message's `data` column, or null. */
  last_msg?: string | null;
}

function defaultDbPath(cfg: AgentIntegrationConfig): string {
  const home = cfg.home
    ? (cfg.home as string).replace(/^~/, os.homedir())
    : process.env.XDG_DATA_HOME
      ? path.join(process.env.XDG_DATA_HOME, "opencode")
      : path.join(os.homedir(), ".local", "share", "opencode");
  return path.join(home, "opencode.db");
}

/** Map one query row to the normalized session. Pure — the unit under test. */
export function mapOpencodeSession(row: OpencodeRow): AgentSession {
  const directory = row.directory ?? undefined;
  const lastMtime = typeof row.time_updated === "number" ? row.time_updated : 0;

  let state: AgentSessionState;
  let reason: string;

  if (row.time_archived) {
    state = "done";
    reason = "archived";
  } else if (row.time_compacting) {
    state = "working";
    reason = "compacting";
  } else {
    const msg = parseLastMessage(row.last_msg);
    if (msg.error) {
      state = "error";
      reason = msg.errorReason ?? "error";
    } else if (msg.role === "assistant") {
      state = msg.completed ? "waiting" : "working";
      reason = msg.completed ? "assistant" : "assistant-streaming";
    } else if (msg.role === "user") {
      state = "working";
      reason = "user";
    } else {
      state = "idle";
      reason = "no-messages";
    }
  }

  const title = (row.title ?? "").trim();
  const project = directory ? path.basename(directory) : title || row.id;
  const session: AgentSession = {
    agent: "opencode",
    sessionId: row.id,
    project,
    cwd: directory,
    state,
    stateReason: reason,
    lastMtime,
  };
  const tin = row.tokens_input ?? 0;
  const tout = row.tokens_output ?? 0;
  if (tin || tout) {
    session.activity = {
      turnCount: 0,
      lastTools: [],
      filesTouched: [],
      tokens: { input: tin, output: tout },
    };
  }
  return session;
}

interface LastMsg {
  role?: string;
  completed?: boolean;
  error?: boolean;
  errorReason?: string;
}

/** Tolerant parse of an OpenCode message `data` JSON blob. */
export function parseLastMessage(raw: string | null | undefined): LastMsg {
  if (!raw) return {};
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
  const role = typeof d.role === "string" ? d.role : undefined;
  const time = (d.time ?? {}) as { completed?: unknown };
  const completed = time.completed != null && time.completed !== 0;
  const err = d.error as { name?: unknown; data?: { message?: unknown } } | undefined;
  let error = false;
  let errorReason: string | undefined;
  if (err && typeof err === "object") {
    error = true;
    const m = err.data?.message;
    errorReason =
      typeof m === "string"
        ? m.slice(0, 80)
        : typeof err.name === "string"
          ? err.name
          : "error";
  }
  return { role, completed, error, errorReason };
}

const QUERY =
  "SELECT s.id AS id, s.directory AS directory, s.title AS title, s.agent AS agent, " +
  "s.time_updated AS time_updated, s.time_archived AS time_archived, " +
  "s.time_compacting AS time_compacting, s.tokens_input AS tokens_input, " +
  "s.tokens_output AS tokens_output, " +
  "(SELECT m.data FROM message m WHERE m.session_id = s.id ORDER BY m.time_created DESC LIMIT 1) AS last_msg " +
  "FROM session s ORDER BY s.time_updated DESC LIMIT 40;";

/** Read sessions from the OpenCode DB via the system sqlite3 CLI. [] on failure. */
async function sqliteFetch(dbPath: string): Promise<OpencodeRow[]> {
  try {
    const { stdout } = await pexec("sqlite3", ["-json", "-readonly", dbPath, QUERY], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 15_000,
    });
    const s = stdout.trim();
    if (!s) return [];
    return JSON.parse(s) as OpencodeRow[];
  } catch {
    return []; // sqlite3 missing, db absent/locked, parse error — graceful no-op
  }
}

export interface OpencodeObserverOptions extends AgentIntegrationConfig {
  /** Override the row fetcher (tests). */
  fetchRows?: () => Promise<OpencodeRow[]>;
  pollMs?: number;
  activeWindowMs?: number;
  now?: () => number;
}

export class OpencodeObserver extends EventEmitter implements AgentObserver {
  readonly agent = "opencode";
  private sessions = new Map<string, AgentSession>();
  private timer: NodeJS.Timeout | null = null;
  private emitFn: ((s: AgentSession) => void) | null = null;
  private readonly fetcher: () => Promise<OpencodeRow[]>;
  private readonly pollMs: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(cfg: OpencodeObserverOptions) {
    super();
    const db = defaultDbPath(cfg);
    this.fetcher = cfg.fetchRows ?? (() => sqliteFetch(db));
    this.pollMs = typeof cfg.pollMs === "number" && cfg.pollMs > 0 ? cfg.pollMs : POLL_MS_DEFAULT;
    this.windowMs =
      typeof cfg.activeWindowMs === "number" && cfg.activeWindowMs > 0
        ? cfg.activeWindowMs
        : ACTIVE_WINDOW_MS_DEFAULT;
    this.now = cfg.now ?? Date.now;
  }

  async start(emit: (s: AgentSession) => void): Promise<void> {
    this.emitFn = emit;
    await this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  list(): AgentSession[] {
    const cutoff = this.now() - this.windowMs;
    return [...this.sessions.values()]
      .filter((s) => s.lastMtime >= cutoff)
      .sort((a, b) => b.lastMtime - a.lastMtime)
      .slice(0, MAX_LISTED);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One refresh cycle — exposed for deterministic tests. */
  async poll(): Promise<void> {
    let rows: OpencodeRow[];
    try {
      rows = await this.fetcher();
    } catch {
      return;
    }
    for (const row of rows) {
      const s = mapOpencodeSession(row);
      const prev = this.sessions.get(s.sessionId);
      this.sessions.set(s.sessionId, s);
      if (this.emitFn && (!prev || prev.state !== s.state || prev.lastMtime !== s.lastMtime)) {
        this.emitFn(s);
      }
    }
  }
}

registerIntegration("opencode", (cfg) => new OpencodeObserver(cfg as OpencodeObserverOptions));
