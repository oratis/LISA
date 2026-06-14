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
 * The Tier-2 activity extractor (parseCodexActivity) extends this with
 * tool NAMES, file PATHS, and command argv[0] — but, crucially, NEVER the
 * `arguments` JSON itself, reasoning text, or message bodies. See the
 * planted-secret privacy test in observer.test.ts.
 *
 * NOTE: Codex's exact rollout schema varies by version; both the state parse
 * and the activity parse are deliberately tolerant (unknown shapes → skipped /
 * "unknown") and the integration is DISABLED by default (opt in via
 * ~/.lisa/agents.json). It graceful-no-ops when $CODEX_HOME/sessions is absent.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
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

/** Constructor options — config plus an injectable branch resolver (tests). */
export interface CodexObserverOptions extends AgentIntegrationConfig {
  gitBranch?: GitBranchResolver;
}

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
  /** Tier-2 structural activity; present only when visibility ≥ "activity". */
  activity?: SessionActivity;
}

export class CodexObserver extends EventEmitter implements AgentObserver {
  readonly agent = "codex";
  private sessionsRoot: string;
  private sessions = new Map<string, CodexSessionInfo>();
  private watcher: fs.FSWatcher | null = null;
  private pending = new Map<string, NodeJS.Timeout>();
  private emitFn: ((s: AgentSession) => void) | null = null;
  private readonly computeActivity: boolean;
  /** O-D1: derive gitBranch from a session's cwd (Codex rollouts don't store one). */
  private readonly resolveBranch: GitBranchResolver;

  constructor(cfg: CodexObserverOptions) {
    super();
    const home = cfg.home
      ? (cfg.home as string).replace(/^~/, os.homedir())
      : process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
    this.sessionsRoot = path.join(home, "sessions");
    // Tier 2: compute structural activity when visibility is "activity" or
    // "intent". At "metadata"/"off" we stay metadata-only (cheaper, and the
    // privacy-minimal default) — mirrors the claude-code observer.
    this.computeActivity =
      cfg.visibility === "activity" || cfg.visibility === "intent";
    this.resolveBranch = cfg.gitBranch ?? cwdGitBranch;
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
      let activity = this.computeActivity
        ? await parseCodexActivity(full)
        : undefined;
      // O-D1: enrich with the branch derived from cwd (Codex doesn't record one).
      if (this.computeActivity && cwd) {
        const gitBranch = await this.resolveBranch(cwd);
        if (gitBranch) {
          activity = { ...(activity ?? { turnCount: 0, lastTools: [], filesTouched: [] }), gitBranch };
        }
      }
      this.sessions.set(full, {
        sessionId: path.basename(full, ".jsonl").replace(/^rollout-/, ""),
        project: cwd ? path.basename(cwd) : path.basename(path.dirname(full)),
        cwd,
        lastMtime: st.mtimeMs,
        state,
        stateReason: reason,
        activity,
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
    activity: i.activity,
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

// ── O2 (Tier 2): structural activity extraction ─────────────────────────────
//
// PRIVACY BOUNDARY (tested in observer.test.ts): this reads ONLY structural
// metadata from a Codex rollout:
//   - tool NAMES        (function_call `.name`)
//   - file PATHS        (a known path key INSIDE the parsed `arguments` JSON:
//                        `path` / `file_path` / `filename`)
//   - command argv[0]   (first token of a shell function_call's command)
//   - error flags       (`is_error` / `error`)
//   - token counts      (`usage` / `token_usage` on any entry)
// It NEVER extracts or returns: the raw `arguments` string, apply_patch bodies,
// reasoning text, message content, assistant replies, user prompts, or any
// command beyond argv[0]. `arguments` is parsed solely to pull the few path /
// command keys above; on parse failure or absence we take nothing. The privacy
// test plants a unique secret in arguments, reasoning, and message content and
// asserts it never appears in the output.

// O-D2: 128KB tail (was 64KB) so long sessions don't under-count tools/files.
const ACTIVITY_TAIL_BYTES = 128 * 1024;
const MAX_TOOLS = 6;
const MAX_FILES = 10;
/** Known path-bearing keys inside a function_call's parsed arguments. */
const PATH_KEYS = ["file_path", "path", "filename"];
/** function_call name substrings that denote a shell/exec call. */
const SHELL_NAME_RE = /shell|bash|exec/i;

export async function parseCodexActivity(
  filePath: string,
): Promise<SessionActivity | undefined> {
  let size: number;
  try {
    const st = await fsp.stat(filePath);
    if (!st.isFile() || st.size === 0) return undefined;
    size = st.size;
  } catch {
    return undefined;
  }

  let tail: string;
  try {
    const fd = await fsp.open(filePath, "r");
    try {
      const length = Math.min(ACTIVITY_TAIL_BYTES, size);
      const buf = Buffer.alloc(length);
      await fd.read(buf, 0, length, size - length);
      tail = buf.toString("utf8");
    } finally {
      await fd.close();
    }
  } catch {
    return undefined;
  }

  const lines = tail.split("\n").filter(Boolean);
  if (size > ACTIVITY_TAIL_BYTES && lines.length > 0) lines.shift();

  let turnCount = 0;
  const toolsInOrder: string[] = [];
  const files: string[] = [];
  let lastCommandName: string | undefined;
  let lastError: string | undefined;
  let inTok = 0;
  let outTok = 0;

  for (const line of lines) {
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e !== "object") continue;
    const obj = e as Record<string, unknown>;

    if (obj.is_error === true || obj.error === true) lastError = "tool error";

    // Token usage may live top-level or under .message — read both shapes,
    // tolerate either snake_case spelling.
    accumulateUsage(obj.usage, obj.token_usage);
    const msg = obj.message;
    if (msg && typeof msg === "object") {
      const m = msg as Record<string, unknown>;
      accumulateUsage(m.usage, m.token_usage);
    }

    // Rough turn counter: assistant/user/response entries (by type OR role).
    const type = readString(obj.type);
    const role =
      readString(obj.role) ??
      (msg && typeof msg === "object"
        ? readString((msg as Record<string, unknown>).role)
        : undefined);
    if (
      type === "assistant" ||
      type === "user" ||
      type === "response" ||
      role === "assistant" ||
      role === "user"
    ) {
      turnCount++;
    }

    // Tool activity: Codex records tool calls as `type: "function_call"`.
    if (type !== "function_call") continue;
    const name = readString(obj.name);
    if (!name) continue;
    toolsInOrder.push(name);

    // `arguments` is a JSON *string* that may contain sensitive content
    // (e.g. an apply_patch body). We parse it ONLY to look up the few known
    // path / command keys below; we never push the raw string anywhere.
    const args = parseArguments(obj.arguments);
    if (!args) continue;

    for (const k of PATH_KEYS) {
      const p = args[k];
      if (typeof p === "string" && p) {
        files.push(p);
        break;
      }
    }

    if (SHELL_NAME_RE.test(name)) {
      const argv0 = shellArgv0(args.command);
      if (argv0) lastCommandName = argv0;
    }
  }

  if (turnCount === 0 && toolsInOrder.length === 0) return undefined;

  return {
    turnCount,
    lastTools: toolsInOrder.slice(-MAX_TOOLS),
    filesTouched: dedupeKeepRecent(files, MAX_FILES),
    lastCommandName,
    lastError,
    // Codex rollouts don't carry a git branch or a permission gate in this
    // shape; leave them undefined rather than guessing.
    gitBranch: undefined,
    pendingPermission: undefined,
    tokens: inTok || outTok ? { input: inTok, output: outTok } : undefined,
  };

  function accumulateUsage(...candidates: unknown[]): void {
    for (const c of candidates) {
      if (!c || typeof c !== "object") continue;
      const u = c as Record<string, unknown>;
      inTok += toNum(u.input_tokens);
      outTok += toNum(u.output_tokens);
    }
  }
}

/**
 * Parse a function_call's `arguments`. Codex stores it as a JSON string; some
 * versions/entries may already hand us an object. Returns a plain record on
 * success, or undefined (we then extract nothing — never the raw value).
 */
function parseArguments(raw: unknown): Record<string, unknown> | undefined {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  return parsed && typeof parsed === "object"
    ? (parsed as Record<string, unknown>)
    : undefined;
}

/**
 * argv[0] of a shell command. Codex may give `command` as an array
 * (["bash","-lc","…"]) or a string. We return ONLY the first token — never
 * the rest of the command line.
 */
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

function readString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function toNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
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

registerIntegration("codex", (cfg) => new CodexObserver(cfg));
