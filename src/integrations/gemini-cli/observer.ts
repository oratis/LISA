/**
 * Gemini CLI observer — read-only adapter for Gemini CLI's local session logs.
 *
 * Gemini CLI persists sessions under `$GEMINI_HOME` (default `~/.gemini`):
 *   `<home>/tmp/<project_hash>/chats/session-*.jsonl`  (streaming JSONL)
 *   `<home>/tmp/<project_hash>/chats/session-*.json`   (legacy JSON)
 * Manual snapshots (`checkpoint-*.json`) are ignored.
 *
 * PRIVACY: strictly structural metadata only — session state, cwd/project,
 * git branch (via cwd), turn counts, tool NAMES, known file PATH keys
 * (`path` / `file_path` / `filePath` / `filename` / `target_file` /
 * `absolute_path`), shell `argv[0]` only, pending approval tool name,
 * categorical error labels, and token counts.
 * NEVER extracts user prompts (`content`/`displayContent`), model replies,
 * `thoughts`, `description`, tool output/results, file contents, or command
 * arguments beyond `argv[0]`.
 *
 * Disabled by default (`"gemini-cli": { enabled: false }`); graceful no-op
 * when `~/.gemini/tmp` is absent.
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

export interface GeminiCliObserverOptions extends AgentIntegrationConfig {
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
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_TOOLS = 6;
const MAX_FILES = 10;
const PATH_KEYS = [
  "file_path",
  "filePath",
  "path",
  "target_file",
  "targetFile",
  "absolute_path",
  "filename",
];
const SHELL_NAME_RE = /shell|bash|exec|command/i;

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

/** Resolve Gemini CLI home directory (`~/.gemini` or `GEMINI_HOME`). */
export function geminiHomeDir(cfg: Pick<AgentIntegrationConfig, "home"> = {}): string {
  if (cfg.home) return cfg.home.replace(/^~/, os.homedir());
  if (process.env.GEMINI_HOME) return process.env.GEMINI_HOME.replace(/^~/, os.homedir());
  return path.join(os.homedir(), ".gemini");
}

function isGeminiSessionFile(name: string): boolean {
  return name.startsWith("session-") && (name.endsWith(".jsonl") || name.endsWith(".json"));
}

/** Collect `tmp/<projectHash>/chats/session-*.{jsonl,json}` under Gemini home. */
export async function walkGeminiSessions(home: string): Promise<string[]> {
  const tmpRoot = path.join(home, "tmp");
  let projectDirs: fs.Dirent[];
  try {
    projectDirs = await fsp.readdir(tmpRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const proj of projectDirs) {
    if (!proj.isDirectory()) continue;
    const chatsDir = path.join(tmpRoot, proj.name, "chats");
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(chatsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && isGeminiSessionFile(e.name)) {
        out.push(path.join(chatsDir, e.name));
      }
    }
  }
  return out;
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

function parseArgsRecord(raw: unknown): JsonRecord | undefined {
  if (typeof raw === "string") {
    try {
      return asRecord(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }
  return asRecord(raw);
}

interface GeminiParsedFile {
  sessionId?: string;
  cwd?: string;
  projectHash?: string;
  records: JsonRecord[];
}

async function readOptionalProjectRoot(sessionFilePath: string): Promise<string | undefined> {
  // Layout: <home>/tmp/<projectHash>/chats/session-*.jsonl
  const chatsDir = path.dirname(sessionFilePath);
  const projectHashDir = path.dirname(chatsDir);
  const rootMarker = path.join(projectHashDir, ".project_root");
  try {
    const st = await fsp.stat(rootMarker);
    if (!st.isFile() || st.size === 0 || st.size > 1024) return undefined;
    const raw = (await fsp.readFile(rootMarker, "utf8")).split("\n", 1)[0]?.trim();
    return raw && raw.startsWith("/") ? raw : undefined;
  } catch {
    return undefined;
  }
}

async function readGeminiRecords(filePath: string): Promise<GeminiParsedFile | null> {
  if (filePath.endsWith(".json")) {
    try {
      const st = await fsp.stat(filePath);
      if (!st.isFile() || st.size === 0 || st.size > MAX_JSON_BYTES) {
        return st.isFile() && st.size === 0 ? { records: [] } : null;
      }
      const parsed = asRecord(JSON.parse(await fsp.readFile(filePath, "utf8")));
      if (!parsed) return { records: [] };
      const msgs = Array.isArray(parsed.messages)
        ? parsed.messages.map(asRecord).filter((r): r is JsonRecord => Boolean(r))
        : [];
      return {
        sessionId: readString(parsed.sessionId),
        cwd: readString(parsed.cwd) ?? readString(parsed.projectRoot),
        projectHash: readString(parsed.projectHash),
        records: msgs,
      };
    } catch {
      return null;
    }
  }

  try {
    const fd = await fsp.open(filePath, "r");
    try {
      const { size } = await fd.stat();
      if (size === 0) return { records: [] };
      const length = Math.min(TAIL_BYTES, size);
      const buf = Buffer.alloc(length);
      const start = size - length;
      const { bytesRead } = await fd.read(buf, 0, length, start);
      let tail = buf.toString("utf8", 0, bytesRead);
      let meta: JsonRecord | undefined;
      if (start > 0) {
        tail = tail.slice(tail.indexOf("\n") + 1);
        const headBuf = Buffer.alloc(Math.min(4096, size));
        const headRead = await fd.read(headBuf, 0, headBuf.length, 0);
        const firstLine = headBuf.toString("utf8", 0, headRead.bytesRead).split("\n", 1)[0];
        if (firstLine) {
          try {
            meta = asRecord(JSON.parse(firstLine));
          } catch {
            meta = undefined;
          }
        }
      }
      const records: JsonRecord[] = [];
      for (const line of tail.split("\n")) {
        if (!line.trim()) continue;
        try {
          const obj = asRecord(JSON.parse(line));
          if (obj) records.push(obj);
        } catch {
          /* skip partial or corrupt line */
        }
      }
      meta ??= records.find((r) => r.type === "session_metadata");
      return {
        sessionId: readString(meta?.sessionId),
        cwd:
          readString(meta?.cwd) ?? readString(meta?.projectRoot) ?? readString(meta?.workspaceRoot),
        projectHash: readString(meta?.projectHash),
        records,
      };
    } finally {
      await fd.close();
    }
  } catch {
    return null;
  }
}

function recordType(r: JsonRecord): string | undefined {
  return readString(r.type) ?? readString(r.role);
}

function inspectToolCallsState(toolCalls: unknown): {
  state?: AgentSessionState;
  reason?: string;
  pendingPermission?: string;
  hasError: boolean;
} {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return { hasError: false };
  }
  let pendingPermission: string | undefined;
  let running = false;
  let hasError = false;
  for (const tc of toolCalls) {
    const r = asRecord(tc);
    if (!r) continue;
    const status = (readString(r.status) ?? "").toLowerCase();
    if (status === "error" || status === "failed" || r.isError === true || asRecord(r.error)) {
      hasError = true;
    }
    if (status === "awaiting_approval" || status === "awaiting-approval") {
      pendingPermission = readString(r.name) ?? "tool";
    } else if (status === "executing" || status === "scheduled" || status === "validating") {
      running = true;
    }
  }
  if (hasError) return { state: "error", reason: "error", hasError: true };
  if (pendingPermission) {
    return { state: "waiting", reason: "permission", pendingPermission, hasError: false };
  }
  if (running) return { state: "working", reason: "tool_call", hasError: false };
  return { hasError: false };
}

/** Derive normalized Gemini CLI session state from JSON/JSONL records. */
export async function parseGeminiState(filePath: string): Promise<{
  state: AgentSessionState;
  reason: string;
  sessionId?: string;
  cwd?: string;
  projectHash?: string;
  pendingPermission?: string;
}> {
  const parsed = await readGeminiRecords(filePath);
  if (!parsed) return { state: "unknown", reason: "read-failed" };
  const cwd = parsed.cwd ?? (await readOptionalProjectRoot(filePath));
  if (parsed.records.length === 0) {
    return {
      state: "unknown",
      reason: "empty",
      sessionId: parsed.sessionId,
      cwd,
      projectHash: parsed.projectHash,
    };
  }

  let sawMetadataOnly = false;
  for (let i = parsed.records.length - 1; i >= 0; i--) {
    const rec = parsed.records[i]!;
    const t = recordType(rec);
    if (t === "session_metadata") {
      sawMetadataOnly = true;
      continue;
    }
    if (t === "error" || rec.isError === true || rec.error === true || asRecord(rec.error)) {
      return {
        state: "error",
        reason: "error",
        sessionId: parsed.sessionId,
        cwd,
        projectHash: parsed.projectHash,
      };
    }
    if (t === "user") {
      return {
        state: "working",
        reason: "user",
        sessionId: parsed.sessionId,
        cwd,
        projectHash: parsed.projectHash,
      };
    }
    if (t === "gemini" || t === "model" || t === "assistant") {
      const tc = inspectToolCallsState(rec.toolCalls);
      if (tc.state) {
        return {
          state: tc.state,
          reason: tc.reason!,
          sessionId: parsed.sessionId,
          cwd,
          projectHash: parsed.projectHash,
          pendingPermission: tc.pendingPermission,
        };
      }
      return {
        state: "waiting",
        reason: "assistant",
        sessionId: parsed.sessionId,
        cwd,
        projectHash: parsed.projectHash,
      };
    }
    if (t === "message_update") {
      const tc = inspectToolCallsState(rec.toolCalls);
      if (tc.state) {
        return {
          state: tc.state,
          reason: tc.reason!,
          sessionId: parsed.sessionId,
          cwd,
          projectHash: parsed.projectHash,
          pendingPermission: tc.pendingPermission,
        };
      }
      if (asRecord(rec.tokens)) {
        return {
          state: "waiting",
          reason: "assistant",
          sessionId: parsed.sessionId,
          cwd,
          projectHash: parsed.projectHash,
        };
      }
      return {
        state: "working",
        reason: "message_update",
        sessionId: parsed.sessionId,
        cwd,
        projectHash: parsed.projectHash,
      };
    }
  }

  return {
    state: sawMetadataOnly ? "idle" : "unknown",
    reason: sawMetadataOnly ? "no-messages" : "no-decision",
    sessionId: parsed.sessionId,
    cwd,
    projectHash: parsed.projectHash,
  };
}

/**
 * Tier-2 structural activity extractor for Gemini CLI JSON/JSONL sessions.
 *
 * PRIVACY BOUNDARY: reads ONLY message types (`user`/`gemini`), tool NAMES
 * (`toolCalls[].name`), known file-path keys inside `toolCalls[].args`/`input`,
 * shell `argv[0]`, error flags, pending approval tool name, and token usage.
 * NEVER reads `content`, `displayContent`, `thoughts`, `description`,
 * `resultDisplay`, `output`, `response`, or command args beyond `argv[0]`.
 */
export async function parseGeminiActivity(filePath: string): Promise<SessionActivity | undefined> {
  const parsed = await readGeminiRecords(filePath);
  if (!parsed || parsed.records.length === 0) return undefined;

  let turnCount = 0;
  const toolsInOrder: string[] = [];
  const files: string[] = [];
  let lastCommandName: string | undefined;
  let lastError: string | undefined;
  let pendingPermission: string | undefined;
  const tokensByMsg = new Map<string, { input: number; output: number }>();
  let anonTokenSeq = 0;

  for (const rec of parsed.records) {
    const t = recordType(rec);
    if (t === "session_metadata") continue;

    if (t === "user" || t === "gemini" || t === "model" || t === "assistant") {
      turnCount++;
      pendingPermission = undefined;
    }
    if (t === "error" || rec.isError === true || rec.error === true || asRecord(rec.error)) {
      lastError = "tool error";
    }

    const tok = asRecord(rec.tokens);
    if (tok) {
      const input = toNum(tok.input ?? tok.input_tokens ?? tok.prompt);
      const output = toNum(tok.output ?? tok.output_tokens ?? tok.candidates);
      if (input || output) {
        const msgId = readString(rec.id) ?? `__anon_${++anonTokenSeq}`;
        tokensByMsg.set(msgId, { input, output });
      }
    }

    const toolCalls = rec.toolCalls;
    if (!Array.isArray(toolCalls)) continue;
    pendingPermission = undefined;
    for (const rawTc of toolCalls) {
      const tc = asRecord(rawTc);
      if (!tc) continue;
      const name = readString(tc.name) ?? readString(tc.toolName) ?? readString(tc.tool);
      if (!name) continue;
      toolsInOrder.push(name);

      const status = (readString(tc.status) ?? "").toLowerCase();
      if (status === "error" || status === "failed" || tc.isError === true || asRecord(tc.error)) {
        lastError = "tool error";
      }
      if (status === "awaiting_approval" || status === "awaiting-approval") {
        pendingPermission = name;
      }

      const args = parseArgsRecord(tc.args ?? tc.input ?? tc.arguments);
      if (!args) continue;
      for (const k of PATH_KEYS) {
        const p = readString(args[k]);
        if (p) {
          files.push(p);
          break;
        }
      }
      if (SHELL_NAME_RE.test(name)) {
        const argv0 = shellArgv0(args.command ?? args.cmd);
        if (argv0) lastCommandName = argv0;
      }
    }
  }

  let inTok = 0;
  let outTok = 0;
  for (const t of tokensByMsg.values()) {
    inTok += t.input;
    outTok += t.output;
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
    pendingPermission,
    tokens: inTok || outTok ? { input: inTok, output: outTok } : undefined,
  };
}

interface GeminiSessionInfo {
  sessionId: string;
  project: string;
  cwd?: string;
  lastMtime: number;
  state: AgentSessionState;
  stateReason: string;
  activity?: SessionActivity;
}

export class GeminiCliObserver extends EventEmitter implements AgentObserver {
  readonly agent = "gemini-cli";
  private readonly home: string;
  private sessions = new Map<string, GeminiSessionInfo>();
  private watcher: fs.FSWatcher | null = null;
  private retry: NodeJS.Timeout | undefined;
  private pending = new Map<string, NodeJS.Timeout>();
  private emitFn: ((s: AgentSession) => void) | null = null;
  private readonly computeActivity: boolean;
  private readonly resolveBranch: GitBranchResolver;
  private readonly now: () => number;
  private readonly activeWindowMs: number;

  constructor(cfg: GeminiCliObserverOptions) {
    super();
    this.home = geminiHomeDir(cfg);
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
    this.attach();
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
    this.watcher?.close();
    this.watcher = null;
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  private async scan(): Promise<void> {
    const files = await walkGeminiSessions(this.home);
    for (const f of files) await this.record(f);
  }

  private attach(): void {
    const tmpRoot = path.join(this.home, "tmp");
    if (!fs.existsSync(tmpRoot)) {
      this.retryAttach();
      return;
    }
    try {
      this.watcher = fs.watch(tmpRoot, { recursive: true, persistent: false }, (_e, filename) => {
        if (!filename) return;
        const base = path.basename(filename);
        if (!isGeminiSessionFile(base)) return;
        const full = path.join(tmpRoot, filename);
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
          }, DEBOUNCE_MS).unref(),
        );
      });
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = null;
        this.retryAttach();
      });
    } catch {
      this.retryAttach();
    }
  }

  private retryAttach(): void {
    if (!this.emitFn) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      this.attach();
      if (this.watcher) void this.scan();
    }, 5000).unref();
  }

  private async record(full: string): Promise<void> {
    try {
      const st = await fsp.stat(full);
      if (!st.isFile() || st.mtimeMs < this.now() - this.activeWindowMs) {
        this.sessions.delete(full);
        return;
      }
      const parsed = await parseGeminiState(full);
      const fallbackId = path.basename(full).replace(/\.(jsonl|json)$/, "");
      const dirHash = path.basename(path.dirname(path.dirname(full)));
      const project = parsed.cwd
        ? path.basename(parsed.cwd)
        : parsed.projectHash
          ? `gemini:${parsed.projectHash.slice(0, 8)}`
          : dirHash
            ? `gemini:${dirHash.slice(0, 8)}`
            : "Gemini CLI";

      let activity = this.computeActivity ? await parseGeminiActivity(full) : undefined;
      if (
        this.computeActivity &&
        parsed.pendingPermission &&
        activity &&
        !activity.pendingPermission
      ) {
        activity.pendingPermission = parsed.pendingPermission;
      }
      if (this.computeActivity && parsed.cwd) {
        const gitBranch = await this.resolveBranch(parsed.cwd);
        if (gitBranch) {
          activity = {
            ...(activity ?? { turnCount: 0, lastTools: [], filesTouched: [] }),
            gitBranch,
          };
        }
      }

      this.sessions.set(full, {
        sessionId: parsed.sessionId ?? fallbackId,
        project,
        cwd: parsed.cwd,
        lastMtime: st.mtimeMs,
        state: parsed.state,
        stateReason: parsed.reason,
        activity,
      });
    } catch {
      this.sessions.delete(full);
    }
  }
}

function toAgentSession(info: GeminiSessionInfo): AgentSession {
  return {
    agent: "gemini-cli",
    sessionId: info.sessionId,
    project: info.project,
    cwd: info.cwd,
    state: info.state,
    stateReason: info.stateReason,
    lastMtime: info.lastMtime,
    activity: info.activity,
  };
}

registerIntegration("gemini-cli", (cfg) => new GeminiCliObserver(cfg));
