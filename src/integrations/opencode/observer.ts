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
 * TIER 2 (visibility ≥ "activity"): in addition to state we extract STRUCTURAL
 * activity from the session's most recent messages — tool NAMES, file PATHS,
 * the last shell command's argv[0], an error label, turn count. The extraction
 * is a pure function (`extractActivity`) over already-parsed message blobs, so
 * it is unit-testable without sqlite and keeps the same 60-second-audit
 * privacy property as the Claude Code parser.
 *
 * PRIVACY: only structural fields — session title, directory, token counts,
 * message role/role-timing/error flag, tool NAMES, file PATHS, command argv[0].
 * NEVER message text, prompt/reply prose, tool inputs beyond known path keys,
 * or full command lines beyond argv[0].
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
  SessionActivity,
} from "../types.js";

const pexec = promisify(execFile);

const POLL_MS_DEFAULT = 60_000;
const ACTIVE_WINDOW_MS_DEFAULT = 6 * 60 * 60_000; // 6h
const MAX_LISTED = 12;

// Tier-2 extraction caps (mirror the Claude Code parser).
const MAX_TOOLS = 6;
const MAX_FILES = 10;
/** How many of a session's most-recent messages to scan for activity. */
const RECENT_MSGS = 20;
/** Known path-bearing keys in a tool part's input. We NEVER read other keys. */
const PATH_KEYS = ["path", "filePath", "file", "filename"];

/** A row of the adapter's query — session columns + recent message data. */
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
  /**
   * JSON-array string of the session's most-recent message `data` blobs
   * (oldest → newest), or null. Only populated/used at visibility ≥ activity.
   */
  recent_msgs?: string | null;
}

function defaultDbPath(cfg: AgentIntegrationConfig): string {
  const home = cfg.home
    ? (cfg.home as string).replace(/^~/, os.homedir())
    : process.env.XDG_DATA_HOME
      ? path.join(process.env.XDG_DATA_HOME, "opencode")
      : path.join(os.homedir(), ".local", "share", "opencode");
  return path.join(home, "opencode.db");
}

/**
 * Map one query row to the normalized session. Pure — the unit under test.
 *
 * When `computeActivity` is true (visibility ≥ "activity") we additionally
 * scan the session's recent messages for structural activity. Otherwise we
 * stay metadata-only, surfacing just token counts (the prior behaviour).
 */
export function mapOpencodeSession(row: OpencodeRow, computeActivity = false): AgentSession {
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
  const tokens = tin || tout ? { input: tin, output: tout } : undefined;

  if (computeActivity) {
    // Deep (Tier-2) path: scan recent messages for structural metadata.
    // The session-row token counts are authoritative, so they win over any
    // per-message usage the extractor may also see.
    const deep = extractActivity(parseRecentMessages(row.recent_msgs));
    if (deep || tokens) {
      session.activity = { ...(deep ?? EMPTY_ACTIVITY), ...(tokens ? { tokens } : {}) };
    }
  } else if (tokens) {
    // Metadata-only path: surface tokens for cost tracking, nothing else.
    session.activity = { turnCount: 0, lastTools: [], filesTouched: [], tokens };
  }
  return session;
}

const EMPTY_ACTIVITY: SessionActivity = { turnCount: 0, lastTools: [], filesTouched: [] };

/** Tolerantly parse the `recent_msgs` JSON-array string into message objects. */
export function parseRecentMessages(raw: string | null | undefined): Record<string, unknown>[] {
  if (!raw) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: Record<string, unknown>[] = [];
  for (const el of arr) {
    // Each element is itself the message `data` column — a JSON string in the
    // DB. Accept both an already-parsed object and a nested JSON string.
    if (el && typeof el === "object") {
      out.push(el as Record<string, unknown>);
    } else if (typeof el === "string") {
      try {
        const o = JSON.parse(el);
        if (o && typeof o === "object") out.push(o as Record<string, unknown>);
      } catch {
        /* skip unparseable */
      }
    }
  }
  return out;
}

/**
 * Pure Tier-2 extractor — STRUCTURAL metadata only.
 *
 * Input: an array of OpenCode message `data` objects, oldest → newest. Each
 * message may carry a `parts` array; a tool part has `type: "tool"`, a tool
 * name (`tool`), and a `state` object whose `input` may contain a file path
 * and/or a command. We read ONLY:
 *   - tool NAMES        (part `.tool` / `.name`)
 *   - file PATHS        (part `state.input[path|filePath|file|filename]`)
 *   - command argv[0]   (first token of a bash/shell tool's `state.input.command`)
 *   - error label       (message `.error`)
 *   - turn count        (one per message)
 * We NEVER read text parts, prompt/reply prose, the rest of a tool's input,
 * or a command beyond its argv[0]. (Privacy-tested in observer.test.ts.)
 *
 * Returns undefined when there is nothing structural to report.
 */
export function extractActivity(
  messages: Record<string, unknown>[],
): SessionActivity | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return undefined;

  let turnCount = 0;
  const toolsInOrder: string[] = [];
  const files: string[] = [];
  let lastCommandName: string | undefined;
  let lastError: string | undefined;

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    turnCount++;

    const errLabel = errorReasonOf(msg);
    if (errLabel) lastError = errLabel;

    const parts = (msg as Record<string, unknown>).parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      // ONLY tool parts. text parts (prompts/replies) are skipped entirely —
      // we never read their `.text`.
      if (readString(p.type) !== "tool") continue;
      const name = readString(p.tool) ?? readString(p.name);
      if (!name) continue;
      toolsInOrder.push(name);

      // A tool part's input lives under `state.input` (newer opencode) or, as a
      // fallback, directly on the part. We read ONLY known path keys + command.
      const input = toolInput(p);
      if (!input) continue;
      for (const k of PATH_KEYS) {
        const v = input[k];
        if (typeof v === "string" && v) {
          files.push(v);
          break;
        }
      }
      if (isShellTool(name)) {
        const cmd = input.command;
        if (typeof cmd === "string" && cmd.trim()) {
          // argv[0] ONLY — never the full command line.
          lastCommandName = cmd.trim().split(/\s+/)[0];
        }
      }
    }
  }

  if (turnCount === 0 && toolsInOrder.length === 0) return undefined;

  return {
    turnCount,
    lastTools: toolsInOrder.slice(-MAX_TOOLS),
    filesTouched: dedupeKeepRecent(files, MAX_FILES),
    lastCommandName,
    lastError,
  };
}

/** Pull a tool part's input object from `state.input` or the part itself. */
function toolInput(part: Record<string, unknown>): Record<string, unknown> | undefined {
  const state = part.state;
  if (state && typeof state === "object") {
    const inp = (state as Record<string, unknown>).input;
    if (inp && typeof inp === "object") return inp as Record<string, unknown>;
  }
  const direct = part.input;
  if (direct && typeof direct === "object") return direct as Record<string, unknown>;
  return undefined;
}

function isShellTool(name: string): boolean {
  const n = name.toLowerCase();
  return n === "bash" || n === "shell";
}

/** Short error label for a message, mirroring parseLastMessage's logic. */
function errorReasonOf(msg: Record<string, unknown>): string | undefined {
  const err = msg.error as { name?: unknown; data?: { message?: unknown } } | undefined;
  if (!err || typeof err !== "object") return undefined;
  const m = err.data?.message;
  if (typeof m === "string") return m.slice(0, 80);
  if (typeof err.name === "string") return err.name;
  return "error";
}

function readString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Dedupe paths keeping each one's most-recent position; cap to `max`. */
function dedupeKeepRecent(items: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (!seen.has(it)) {
      seen.add(it);
      out.unshift(it);
    }
  }
  return out.slice(-max);
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

const COL_LAST_MSG =
  "(SELECT m.data FROM message m WHERE m.session_id = s.id ORDER BY m.time_created DESC LIMIT 1) AS last_msg";

// Tier-2 only: the most-recent N messages' `data`, aggregated into a JSON array
// (oldest → newest via the outer ORDER BY). json_group_array preserves the
// subquery order. Each element is the raw `data` JSON string; extractActivity's
// parseRecentMessages tolerates that.
const COL_RECENT_MSGS =
  "(SELECT json_group_array(d) FROM " +
  `(SELECT m.data AS d FROM message m WHERE m.session_id = s.id ORDER BY m.time_created DESC LIMIT ${RECENT_MSGS}) ` +
  "ORDER BY rowid DESC) AS recent_msgs";

function buildQuery(withActivity: boolean): string {
  const cols = [
    "s.id AS id",
    "s.directory AS directory",
    "s.title AS title",
    "s.agent AS agent",
    "s.time_updated AS time_updated",
    "s.time_archived AS time_archived",
    "s.time_compacting AS time_compacting",
    "s.tokens_input AS tokens_input",
    "s.tokens_output AS tokens_output",
    COL_LAST_MSG,
  ];
  if (withActivity) cols.push(COL_RECENT_MSGS);
  return `SELECT ${cols.join(", ")} FROM session s ORDER BY s.time_updated DESC LIMIT 40;`;
}

/** Read sessions from the OpenCode DB via the system sqlite3 CLI. [] on failure. */
async function sqliteFetch(dbPath: string, withActivity: boolean): Promise<OpencodeRow[]> {
  try {
    const { stdout } = await pexec(
      "sqlite3",
      ["-json", "-readonly", dbPath, buildQuery(withActivity)],
      {
        maxBuffer: 16 * 1024 * 1024,
        timeout: 15_000,
      },
    );
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
  /** Tier-2 gate: only at visibility ≥ "activity" do we deep-extract. */
  private readonly computeActivity: boolean;

  constructor(cfg: OpencodeObserverOptions) {
    super();
    const db = defaultDbPath(cfg);
    // Tier 2: compute structural activity when visibility is "activity" or
    // "intent". At "metadata"/"off" we stay metadata-only (cheaper, and the
    // privacy-minimal default) — same gate as the Claude Code observer.
    this.computeActivity = cfg.visibility === "activity" || cfg.visibility === "intent";
    this.fetcher = cfg.fetchRows ?? (() => sqliteFetch(db, this.computeActivity));
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
      const s = mapOpencodeSession(row, this.computeActivity);
      const prev = this.sessions.get(s.sessionId);
      this.sessions.set(s.sessionId, s);
      if (this.emitFn && (!prev || prev.state !== s.state || prev.lastMtime !== s.lastMtime)) {
        this.emitFn(s);
      }
    }
  }
}

registerIntegration("opencode", (cfg) => new OpencodeObserver(cfg as OpencodeObserverOptions));
