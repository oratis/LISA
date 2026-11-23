/**
 * Cursor CLI observer — read-only adapter for Cursor's local CLI agent stores.
 *
 * Cursor CLI (`agent` / `cursor-agent`) writes session artifacts under
 * `$CURSOR_CONFIG_DIR` (defaults to `~/.cursor`) in two forms:
 *   1. `<home>/projects/<enc-cwd>/agent-transcripts/**\/*.jsonl` — flat JSONL
 *      transcripts with user/assistant/tool entries.
 *   2. `<home>/chats/<workspace-hash>/<chat-uuid>/meta.json` (+ `store.db`) —
 *      content-addressed CLI chat directories.
 *
 * PRIVACY: strictly structural metadata only — session state, cwd, project
 * basename, git branch (via cwd), turn counts, tool NAMES, known file PATH
 * keys (`path` / `file_path` / `filePath` / `target_file` / `filename`),
 * shell `argv[0]` only, categorical error labels, and token counts.
 * NEVER reads message prose, prompt text, assistant replies, reasoning text,
 * `meta.json` chat titles/names, file contents, patches, or full commands.
 * Disabled by default (`cursor: { enabled: false }`); graceful no-op when
 * `~/.cursor` is absent.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { registerIntegration } from "../registry.js";
import { cwdGitBranch, type GitBranchResolver } from "../git/branch.js";
import type {
  AgentIntegrationConfig,
  AgentObserver,
  AgentSession,
  AgentSessionState,
  SessionActivity,
} from "../types.js";

export interface CursorObserverOptions extends AgentIntegrationConfig {
  /** Clock override (tests). */
  now?: () => number;
  /** Active-session recency window ms (default 30m). */
  activeWindowMs?: number;
  /** O-D1: injectable git branch resolver (tests). */
  gitBranch?: GitBranchResolver;
}

const ACTIVE_WINDOW_MS_DEFAULT = 30 * 60_000;
const MAX_LISTED = 10;
const DEBOUNCE_MS = 300;
const TAIL_BYTES = 128 * 1024;
const MAX_TOOLS = 6;
const MAX_FILES = 10;
const PATH_KEYS = ["file_path", "filePath", "path", "target_file", "targetFile", "filename"];
const SHELL_NAME_RE = /shell|bash|exec|terminal|command/i;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toNum(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function dedupeKeepRecent(items: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (!seen.has(item)) {
      seen.add(item);
      out.unshift(item);
    }
  }
  return out.slice(-max);
}

/** Resolve Cursor CLI config/session home. */
export function cursorHomeDir(cfg: Pick<AgentIntegrationConfig, "home"> = {}): string {
  if (cfg.home) return cfg.home.replace(/^~/, os.homedir());
  if (process.env.CURSOR_CONFIG_DIR) {
    return process.env.CURSOR_CONFIG_DIR.replace(/^~/, os.homedir());
  }
  return path.join(os.homedir(), ".cursor");
}

/** Collect `agent-transcripts/*.jsonl` and `chats/<hash>/<id>/meta.json` under home. */
export async function walkCursorSessions(
  home: string,
): Promise<{ transcripts: string[]; chatMetas: string[] }> {
  const transcripts: string[] = [];
  const chatMetas: string[] = [];

  async function walkTranscripts(dir: string, depth: number): Promise<void> {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walkTranscripts(full, depth + 1);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        transcripts.push(full);
      }
    }
  }

  async function walkProjects(): Promise<void> {
    const projectsRoot = path.join(home, "projects");
    let projEntries: fs.Dirent[];
    try {
      projEntries = await fsp.readdir(projectsRoot, { withFileTypes: true });
    } catch {
      return;
    }
    for (const p of projEntries) {
      if (!p.isDirectory()) continue;
      await walkTranscripts(path.join(projectsRoot, p.name, "agent-transcripts"), 0);
    }
  }

  async function walkChats(): Promise<void> {
    const chatsRoot = path.join(home, "chats");
    let workspaces: fs.Dirent[];
    try {
      workspaces = await fsp.readdir(chatsRoot, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ws of workspaces) {
      if (!ws.isDirectory()) continue;
      const wsDir = path.join(chatsRoot, ws.name);
      let chats: fs.Dirent[];
      try {
        chats = await fsp.readdir(wsDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const c of chats) {
        if (!c.isDirectory()) continue;
        const meta = path.join(wsDir, c.name, "meta.json");
        try {
          const st = await fsp.stat(meta);
          if (st.isFile()) chatMetas.push(meta);
        } catch {
          /* ignore absent meta.json */
        }
      }
    }
  }

  await Promise.all([walkProjects(), walkChats()]);
  return { transcripts, chatMetas };
}

function shellArgv0(command: unknown): string | undefined {
  if (Array.isArray(command)) {
    const first = command.find((c) => typeof c === "string" && c.trim());
    return typeof first === "string" ? first.trim().split(/\s+/)[0] : undefined;
  }
  if (typeof command === "string" && command.trim()) {
    return command.trim().split(/\s+/)[0];
  }
  return undefined;
}

function parseInputRecord(raw: unknown): JsonRecord | undefined {
  if (typeof raw === "string") {
    try {
      return asRecord(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }
  return asRecord(raw);
}

interface ParsedToolCall {
  name: string;
  input?: JsonRecord;
  isError?: boolean;
}

function extractEntryToolCalls(obj: JsonRecord): {
  calls: ParsedToolCall[];
  hasToolResult: boolean;
  hasError: boolean;
} {
  const calls: ParsedToolCall[] = [];
  let hasToolResult = false;
  let hasError = obj.is_error === true || obj.isError === true || obj.error === true;
  if (asRecord(obj.error)) hasError = true;

  const type = readString(obj.type);
  if (type === "error") hasError = true;

  if (type === "tool_use" || type === "tool-call" || type === "function_call") {
    const name = readString(obj.name) ?? readString(obj.toolName) ?? readString(obj.tool);
    if (name) {
      calls.push({
        name,
        input: parseInputRecord(obj.input ?? obj.args ?? obj.arguments),
      });
    }
  } else if (type === "tool_result" || type === "tool-result") {
    hasToolResult = true;
  }

  const msg = asRecord(obj.message) ?? obj;
  if (msg.is_error === true || msg.isError === true || asRecord(msg.error)) hasError = true;

  const topToolCalls = Array.isArray(obj.toolCalls)
    ? obj.toolCalls
    : Array.isArray(msg.toolCalls)
      ? msg.toolCalls
      : [];
  for (const tc of topToolCalls) {
    const r = asRecord(tc);
    if (!r) continue;
    const name = readString(r.name) ?? readString(r.toolName) ?? readString(r.tool);
    const tcErr =
      r.is_error === true ||
      r.isError === true ||
      r.status === "error" ||
      asRecord(r.error) !== undefined;
    if (tcErr) hasError = true;
    if (name) {
      calls.push({
        name,
        input: parseInputRecord(r.input ?? r.args ?? r.arguments),
        isError: tcErr,
      });
    }
  }

  const content = msg.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = asRecord(block);
      if (!b) continue;
      const bType = readString(b.type);
      if (b.is_error === true || b.isError === true) hasError = true;
      if (bType === "tool_use" || bType === "tool-call") {
        const name = readString(b.name) ?? readString(b.toolName) ?? readString(b.tool);
        if (name) {
          calls.push({
            name,
            input: parseInputRecord(b.input ?? b.args ?? b.arguments),
          });
        }
      } else if (bType === "tool_result" || bType === "tool-result") {
        hasToolResult = true;
      }
    }
  }

  return { calls, hasToolResult, hasError };
}

function entryRole(obj: JsonRecord): string | undefined {
  const msg = asRecord(obj.message);
  return (
    readString(obj.role) ??
    readString(msg?.role) ??
    (obj.type === "user" || obj.type === "assistant" || obj.type === "tool" ? obj.type : undefined)
  );
}

function entryCwd(obj: JsonRecord): string | undefined {
  const msg = asRecord(obj.message);
  return (
    readString(obj.cwd) ??
    readString(obj.workspacePath) ??
    readString(msg?.cwd) ??
    readString(asRecord(obj.metadata)?.cwd)
  );
}

async function readTailLines(
  filePath: string,
): Promise<{ header?: string; lines: string[] } | null> {
  try {
    const fd = await fsp.open(filePath, "r");
    try {
      const { size } = await fd.stat();
      if (size === 0) return { lines: [] };
      const length = Math.min(TAIL_BYTES, size);
      const buf = Buffer.alloc(length);
      const start = size - length;
      const { bytesRead } = await fd.read(buf, 0, length, start);
      let tail = buf.toString("utf8", 0, bytesRead);
      let header: string | undefined;
      if (start > 0) {
        tail = tail.slice(tail.indexOf("\n") + 1);
        const headBuf = Buffer.alloc(Math.min(4096, size));
        const headRead = await fd.read(headBuf, 0, headBuf.length, 0);
        header = headBuf.toString("utf8", 0, headRead.bytesRead).split("\n", 1)[0];
      }
      const lines = tail.split("\n").filter((l) => l.trim().length > 0);
      return { header, lines };
    } finally {
      await fd.close();
    }
  } catch {
    return null;
  }
}

function parseJsonLine(line: string): JsonRecord | undefined {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
}

/** Derive Cursor transcript state & optional cwd from JSONL tail. Pure over file contents. */
export async function parseCursorState(filePath: string): Promise<{
  state: AgentSessionState;
  reason: string;
  cwd?: string;
}> {
  const data = await readTailLines(filePath);
  if (!data) return { state: "unknown", reason: "read-failed" };
  if (data.lines.length === 0) return { state: "unknown", reason: "empty" };

  let cwd: string | undefined;
  if (data.header) {
    const h = parseJsonLine(data.header);
    if (h) cwd = entryCwd(h);
  }

  let decision: { state: AgentSessionState; reason: string } | undefined;
  for (let i = data.lines.length - 1; i >= 0; i--) {
    const obj = parseJsonLine(data.lines[i]!);
    if (!obj) continue;
    cwd ??= entryCwd(obj);
    if (decision) {
      if (cwd) break;
      continue;
    }

    const type = readString(obj.type);
    const role = entryRole(obj);
    const { calls, hasToolResult, hasError } = extractEntryToolCalls(obj);

    if (hasError) {
      decision = { state: "error", reason: "error" };
    } else if (role === "assistant") {
      const stopReason = readString(obj.stop_reason) ?? readString(obj.finishReason);
      const midTool =
        stopReason === "tool_use" ||
        stopReason === "tool-calls" ||
        (calls.length > 0 && !hasToolResult);
      decision = midTool
        ? { state: "working", reason: "tool_use" }
        : { state: "waiting", reason: "assistant" };
    } else if (
      role === "user" ||
      role === "tool" ||
      type === "tool_use" ||
      type === "tool-call" ||
      type === "tool_result" ||
      type === "tool-result" ||
      type === "function_call"
    ) {
      decision = { state: "working", reason: type ?? role ?? "working" };
    }
  }

  return { ...(decision ?? { state: "unknown", reason: "no-decision" }), cwd };
}

/**
 * Tier-2 structural activity extractor for Cursor CLI JSONL transcripts.
 *
 * PRIVACY BOUNDARY: reads ONLY turn roles, tool names, known file-path keys
 * (`file_path`/`filePath`/`path`/`target_file`/`targetFile`/`filename`),
 * shell `argv[0]`, error flags, and token counts. Never extracts message prose,
 * reasoning text, patches, or command arguments.
 */
export async function parseCursorActivity(filePath: string): Promise<SessionActivity | undefined> {
  const data = await readTailLines(filePath);
  if (!data || data.lines.length === 0) return undefined;

  let turnCount = 0;
  const toolsInOrder: string[] = [];
  const files: string[] = [];
  let lastCommandName: string | undefined;
  let lastError: string | undefined;
  let inTok = 0;
  let outTok = 0;

  for (const line of data.lines) {
    const obj = parseJsonLine(line);
    if (!obj) continue;

    const role = entryRole(obj);
    if (role === "user" || role === "assistant") turnCount++;

    const { calls, hasError } = extractEntryToolCalls(obj);
    if (hasError) lastError = "tool error";

    for (const call of calls) {
      toolsInOrder.push(call.name);
      if (!call.input) continue;
      for (const key of PATH_KEYS) {
        const p = readString(call.input[key]);
        if (p) {
          files.push(p);
          break;
        }
      }
      if (SHELL_NAME_RE.test(call.name)) {
        const argv0 = shellArgv0(call.input.command ?? call.input.cmd);
        if (argv0) lastCommandName = argv0;
      }
    }

    const msg = asRecord(obj.message);
    for (const usageCandidate of [obj.usage, obj.token_usage, msg?.usage, msg?.token_usage]) {
      const u = asRecord(usageCandidate);
      if (!u) continue;
      inTok += toNum(u.input_tokens ?? u.prompt_tokens ?? u.input);
      outTok += toNum(u.output_tokens ?? u.completion_tokens ?? u.output);
    }
  }

  if (turnCount === 0 && toolsInOrder.length === 0 && !inTok && !outTok && !lastError) {
    return undefined;
  }

  return {
    turnCount,
    lastTools: toolsInOrder.slice(-MAX_TOOLS),
    filesTouched: dedupeKeepRecent(files, MAX_FILES),
    lastCommandName,
    lastError,
    tokens: inTok || outTok ? { input: inTok, output: outTok } : undefined,
  };
}

/**
 * Parse structural fields from a Cursor `<home>/chats/<hash>/<id>/meta.json`
 * without ever reading chat titles/names or prompt text. Pure over JSON string.
 */
export function parseCursorChatMeta(
  raw: string,
  fallbackMtime: number,
): {
  cwd?: string;
  lastMtime: number;
  state: AgentSessionState;
  stateReason: string;
} {
  let obj: JsonRecord | undefined;
  try {
    obj = asRecord(JSON.parse(raw));
  } catch {
    return { lastMtime: fallbackMtime, state: "unknown", stateReason: "invalid-meta" };
  }
  if (!obj) {
    return { lastMtime: fallbackMtime, state: "unknown", stateReason: "invalid-meta" };
  }
  const cwd = readString(obj.cwd) ?? readString(obj.workspacePath);
  const updated =
    toNum(obj.updatedAtMs ?? obj.updatedAt ?? obj.createdAtMs ?? obj.createdAt) || fallbackMtime;
  const rawState = (readString(obj.status) ?? readString(obj.state) ?? "").toLowerCase();

  let state: AgentSessionState;
  let stateReason: string;
  if (rawState === "error" || rawState === "failed") {
    state = "error";
    stateReason = rawState;
  } else if (rawState === "working" || rawState === "running" || rawState === "streaming") {
    state = "working";
    stateReason = rawState;
  } else if (rawState === "done" || rawState === "completed" || rawState === "archived") {
    state = "done";
    stateReason = rawState;
  } else if (obj.hasConversation === false) {
    state = "idle";
    stateReason = "new-session";
  } else {
    state = "waiting";
    stateReason = "chat-store";
  }

  return { cwd, lastMtime: updated, state, stateReason };
}

interface CursorSessionInfo {
  sessionId: string;
  project: string;
  cwd?: string;
  lastMtime: number;
  state: AgentSessionState;
  stateReason: string;
  activity?: SessionActivity;
  /** Internal path of the backing transcript file (if any), never exposed on AgentSession. */
  transcriptPath?: string;
}

export class CursorObserver extends EventEmitter implements AgentObserver {
  readonly agent = "cursor";
  private readonly home: string;
  private sessions = new Map<string, CursorSessionInfo>();
  private watchers: fs.FSWatcher[] = [];
  private retry: NodeJS.Timeout | undefined;
  private pending = new Map<string, NodeJS.Timeout>();
  private emitFn: ((s: AgentSession) => void) | null = null;
  private readonly computeActivity: boolean;
  private readonly resolveBranch: GitBranchResolver;
  private readonly now: () => number;
  private readonly activeWindowMs: number;

  constructor(cfg: CursorObserverOptions) {
    super();
    this.home = cursorHomeDir(cfg);
    this.computeActivity = cfg.visibility === "activity" || cfg.visibility === "intent";
    this.resolveBranch = cfg.gitBranch ?? cwdGitBranch;
    this.now = cfg.now ?? Date.now;
    this.activeWindowMs =
      typeof cfg.activeWindowMs === "number" && cfg.activeWindowMs > 0
        ? cfg.activeWindowMs
        : ACTIVE_WINDOW_MS_DEFAULT;
  }

  async start(emit: (s: AgentSession) => void): Promise<void> {
    this.emitFn = emit;
    this.attachAll();
    await this.scan();
  }

  list(): AgentSession[] {
    const cutoff = this.now() - this.activeWindowMs;
    return [...this.sessions.values()]
      .filter((s) => s.lastMtime >= cutoff)
      .sort((a, b) => b.lastMtime - a.lastMtime)
      .slice(0, MAX_LISTED)
      .map(toAgentSession);
  }

  async stop(): Promise<void> {
    this.emitFn = null;
    clearTimeout(this.retry);
    this.retry = undefined;
    for (const w of this.watchers) w.close();
    this.watchers = [];
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  private attachAll(): void {
    for (const sub of ["projects", "chats"]) {
      const root = path.join(this.home, sub);
      if (!fs.existsSync(root)) continue;
      this.attachRoot(root);
    }
    if (this.watchers.length === 0) this.retryAttach();
  }

  private attachRoot(root: string): void {
    try {
      const w = fs.watch(root, { recursive: true, persistent: false }, (_e, filename) => {
        if (!filename) return;
        const base = path.basename(filename);
        if (!base.endsWith(".jsonl") && base !== "meta.json") return;
        const full = path.join(root, filename);
        const prev = this.pending.get(full);
        if (prev) clearTimeout(prev);
        this.pending.set(
          full,
          setTimeout(() => {
            this.pending.delete(full);
            void this.handleWatchEvent(full);
          }, DEBOUNCE_MS).unref(),
        );
      });
      w.on("error", () => {
        w.close();
        this.watchers = this.watchers.filter((x) => x !== w);
        if (this.watchers.length === 0) this.retryAttach();
      });
      this.watchers.push(w);
    } catch {
      /* absent or unwatchable — graceful no-op */
    }
  }

  private retryAttach(): void {
    if (!this.emitFn) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      this.attachAll();
      if (this.watchers.length > 0) void this.scan();
    }, 5000).unref();
  }

  private async handleWatchEvent(full: string): Promise<void> {
    if (full.endsWith(".jsonl")) {
      await this.recordTranscript(full);
      const id = path.basename(full, ".jsonl");
      const info = this.sessions.get(id);
      if (info && this.emitFn) this.emitFn(toAgentSession(info));
    } else if (path.basename(full) === "meta.json") {
      await this.recordChatMeta(full);
      const id = path.basename(path.dirname(full));
      const info = this.sessions.get(id);
      if (info && this.emitFn) this.emitFn(toAgentSession(info));
    }
  }

  private async scan(): Promise<void> {
    const { transcripts, chatMetas } = await walkCursorSessions(this.home);
    // Read chat metas first so transcript files enrich/override with richer state/activity.
    for (const m of chatMetas) await this.recordChatMeta(m);
    for (const t of transcripts) await this.recordTranscript(t);
  }

  private async recordChatMeta(metaPath: string): Promise<void> {
    try {
      const st = await fsp.stat(metaPath);
      if (!st.isFile()) return;
      const raw = await fsp.readFile(metaPath, "utf8");
      const parsed = parseCursorChatMeta(raw, st.mtimeMs);
      const lastMtime = Math.max(parsed.lastMtime, st.mtimeMs);
      if (lastMtime < this.now() - this.activeWindowMs) return;
      const sessionId = path.basename(path.dirname(metaPath));
      const existing = this.sessions.get(sessionId);
      // Do not overwrite an already-recorded richer transcript session; only fill cwd if absent.
      if (existing?.transcriptPath) {
        if (!existing.cwd && parsed.cwd) {
          existing.cwd = parsed.cwd;
          existing.project = path.basename(parsed.cwd);
        }
        return;
      }
      let activity: SessionActivity | undefined;
      if (this.computeActivity && parsed.cwd) {
        const gitBranch = await this.resolveBranch(parsed.cwd);
        if (gitBranch) {
          activity = { turnCount: 0, lastTools: [], filesTouched: [], gitBranch };
        }
      }
      this.sessions.set(sessionId, {
        sessionId,
        project: parsed.cwd ? path.basename(parsed.cwd) : "Cursor",
        cwd: parsed.cwd,
        lastMtime,
        state: parsed.state,
        stateReason: parsed.stateReason,
        activity,
      });
    } catch {
      /* ignore deleted/unreadable meta.json */
    }
  }

  private async recordTranscript(full: string): Promise<void> {
    const sessionId = path.basename(full, ".jsonl");
    try {
      const st = await fsp.stat(full);
      if (!st.isFile() || st.mtimeMs < this.now() - this.activeWindowMs) {
        if (this.sessions.get(sessionId)?.transcriptPath === full) {
          this.sessions.delete(sessionId);
        }
        return;
      }
      const existing = this.sessions.get(sessionId);
      const { state, reason, cwd: parsedCwd } = await parseCursorState(full);
      const cwd = parsedCwd ?? existing?.cwd;
      let activity = this.computeActivity ? await parseCursorActivity(full) : undefined;
      if (this.computeActivity && cwd) {
        const gitBranch = await this.resolveBranch(cwd);
        if (gitBranch) {
          activity = {
            ...(activity ?? { turnCount: 0, lastTools: [], filesTouched: [] }),
            gitBranch,
          };
        }
      }
      this.sessions.set(sessionId, {
        sessionId,
        project: cwd ? path.basename(cwd) : "Cursor",
        cwd,
        lastMtime: st.mtimeMs,
        state,
        stateReason: reason,
        activity,
        transcriptPath: full,
      });
    } catch {
      if (this.sessions.get(sessionId)?.transcriptPath === full) {
        this.sessions.delete(sessionId);
      }
    }
  }
}

function toAgentSession(info: CursorSessionInfo): AgentSession {
  return {
    agent: "cursor",
    sessionId: info.sessionId,
    project: info.project,
    cwd: info.cwd,
    state: info.state,
    stateReason: info.stateReason,
    lastMtime: info.lastMtime,
    activity: info.activity,
  };
}

registerIntegration("cursor", (cfg) => new CursorObserver(cfg));
