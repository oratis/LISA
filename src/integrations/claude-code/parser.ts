/**
 * Claude Code session state parser — Phase 2 of issue #27.
 *
 * Reads the TAIL of a session jsonl (last 32KB max) to derive whether
 * Claude Code is currently:
 *
 *   - "working"  — Claude is mid-turn (tool call in flight, or assistant
 *                  streaming, or user just sent something)
 *   - "waiting"  — Claude finished (stopReason: end_turn) and is now
 *                  awaiting the next user message; OR Claude requested a
 *                  tool that needs permission
 *   - "error"    — most recent meaningful line has is_error: true,
 *                  hookErrors > 0, or an explicit error envelope
 *   - "unknown"  — couldn't decide (file empty, malformed, only meta
 *                  entries)
 *
 * ── PRIVACY CONTRACT (extends watcher.ts) ──────────────────────────
 *
 *   We DO read jsonl in this module — necessary to derive state —
 *   but we ONLY ever inspect structural / metadata fields:
 *
 *     • type
 *     • stopReason
 *     • is_error / error
 *     • hookErrors / hookCount
 *     • subtype
 *
 *   We NEVER read, log, transmit, or persist `content`, `text`,
 *   `message.content`, prompts, or replies. The parser destructures
 *   only the fields above and discards the rest. A reviewer can audit
 *   the entire module in 60 seconds — search for `content` or `text`
 *   should produce zero hits except in comments like this one.
 *
 * ── ROBUSTNESS ──────────────────────────────────────────────────────
 *
 *   Claude Code's jsonl format may change between versions. Unknown
 *   shapes return "unknown" rather than throwing. Malformed JSON lines
 *   are skipped. Partial writes during streaming are tolerated (we
 *   take the LAST complete line). File deletion mid-parse returns
 *   "unknown".
 */

import fsp from "node:fs/promises";
import type { SessionActivity } from "../types.js";

export type ClaudeSessionState = "working" | "waiting" | "error" | "unknown";

export interface SessionStateInfo {
  state: ClaudeSessionState;
  /** Short label for tooltips / debugging — never user content. */
  reason: string;
  /**
   * Working directory recorded by Claude Code in the jsonl's `.cwd`
   * field (top-level, schema metadata — not message content). Used
   * by the island UI for the "Open in Finder" / "Copy resume command"
   * actions. May be undefined if the jsonl doesn't include it.
   */
  cwd?: string;
}

const META_TYPES = new Set([
  "ai-title",
  "custom-title",
  "last-prompt",
  "queue-operation",
  "attachment",
  // pr-link entries are written when Claude Code creates a PR. They
  // appear after the actual conversation activity and would otherwise
  // mask the real last-state if we stopped at the bottom-most line.
  "pr-link",
]);

const TAIL_BYTES = 32 * 1024;

export async function parseSessionState(filePath: string): Promise<SessionStateInfo> {
  let size: number;
  try {
    const st = await fsp.stat(filePath);
    if (!st.isFile()) return { state: "unknown", reason: "not-a-file" };
    size = st.size;
  } catch {
    return { state: "unknown", reason: "stat-failed" };
  }
  if (size === 0) return { state: "unknown", reason: "empty" };

  let tail: string;
  try {
    const fd = await fsp.open(filePath, "r");
    try {
      const length = Math.min(TAIL_BYTES, size);
      const buf = Buffer.alloc(length);
      await fd.read(buf, 0, length, size - length);
      tail = buf.toString("utf8");
    } finally {
      await fd.close();
    }
  } catch {
    return { state: "unknown", reason: "read-failed" };
  }

  // Drop the first partial line if we didn't read from the very start —
  // it might be truncated mid-record. (Doesn't matter for our purposes
  // since we walk from the bottom anyway, but cheap insurance.)
  const lines = tail.split("\n").filter(Boolean);
  if (size > TAIL_BYTES && lines.length > 0) lines.shift();

  // Walk bottom-up, skip meta entries, decide on the first real one.
  // While walking, also harvest `cwd` (top-level metadata field set
  // by Claude Code at session start) — it's commonly present on every
  // line, so we'll find it quickly.
  let foundCwd: string | undefined;
  let decision: SessionStateInfo | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!foundCwd) {
      foundCwd = sniffCwd(line);
    }
    if (decision === null) {
      decision = decide(line);
    }
    if (decision !== null && foundCwd) break;
  }
  if (decision !== null) {
    return { ...decision, cwd: foundCwd };
  }
  return { state: "unknown", reason: "only-meta", cwd: foundCwd };
}

/**
 * Extract only the top-level `.cwd` string from a line, without
 * parsing the rest. We do a full JSON.parse here for safety (the
 * `cwd` could in theory contain `}` chars), but immediately discard
 * everything except the cwd field. Same privacy rule: structural
 * metadata only, never `content` / `text`.
 */
function sniffCwd(line: string): string | undefined {
  try {
    const obj = JSON.parse(line);
    if (obj && typeof obj === "object") {
      const cwd = (obj as Record<string, unknown>).cwd;
      if (typeof cwd === "string" && cwd.startsWith("/")) return cwd;
    }
  } catch { /* skip */ }
  return undefined;
}

/**
 * Parse one jsonl line and decide whether it carries enough info to
 * declare a state. Returns null to mean "keep walking" (meta or
 * unparseable).
 *
 * Destructures only metadata fields. Never touches content / text /
 * message bodies.
 */
function decide(line: string): SessionStateInfo | null {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;

  const type = readString(e.type);
  if (!type) return null;
  if (META_TYPES.has(type)) return null;

  // Privacy: from this point on we only ever read metadata fields.
  // Real Claude Code jsonl puts stop_reason nested under .message —
  // we read it via a typed accessor that never touches .message.content.
  const stopReason = readNestedStopReason(e);
  const subtype = readString(e.subtype);
  const isError = e.is_error === true || e.error === true;
  const hookErrors = typeof e.hookErrors === "number" && (e.hookErrors as number) > 0;

  if (isError || hookErrors) {
    return { state: "error", reason: "is_error" };
  }

  if (type === "assistant") {
    // `end_turn` = Claude finished talking, waiting for user reply
    // `tool_use` = Claude wants to run a tool. In Claude Code this is
    //              usually mid-loop (tool runs, result comes back,
    //              Claude continues) — so we report "working" unless
    //              the tool requires permission, which surfaces as a
    //              separate system entry we'd see later.
    if (stopReason === "end_turn")      return { state: "waiting", reason: "end_turn" };
    if (stopReason === "tool_use")      return { state: "working", reason: "tool_use" };
    if (stopReason === "max_tokens")    return { state: "waiting", reason: "max_tokens" };
    if (stopReason === "stop_sequence") return { state: "waiting", reason: "stop_sequence" };
    // Unknown / no stop_reason yet — likely streaming in progress.
    return { state: "working", reason: "assistant" };
  }

  if (type === "user") {
    // The user just typed — Claude is about to (or already) respond.
    return { state: "working", reason: "user" };
  }

  if (type === "tool_use") {
    return { state: "working", reason: "tool_use" };
  }

  if (type === "system") {
    // Permission prompts often come as system entries with a
    // subtype like "permission_request" / "tool_permission". Treat
    // them as "waiting" (user needs to approve).
    if (subtype && /permission/i.test(subtype)) {
      return { state: "waiting", reason: "permission" };
    }
    // Other system entries are transient — keep walking.
    return null;
  }

  // Unknown but non-meta type — keep walking; if everything above
  // turns out to be unknown, the caller's loop will fall through to
  // "unknown" anyway.
  return null;
}

function readString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Claude Code stores stop_reason nested under `.message.stop_reason`
 * (snake_case). We extract ONLY that one field; `.message.content`,
 * `.message.text`, etc. are deliberately never touched.
 */
function readNestedStopReason(e: Record<string, unknown>): string | undefined {
  const direct = readString(e.stopReason) ?? readString(e.stop_reason);
  if (direct) return direct;
  const msg = e.message;
  if (msg && typeof msg === "object") {
    const m = msg as Record<string, unknown>;
    return readString(m.stop_reason) ?? readString(m.stopReason);
  }
  return undefined;
}

// ── O2 (Tier 2): structural activity extraction ─────────────────────────────
//
// PRIVACY BOUNDARY (tested in parser.test.ts): this function reads ONLY
// structural metadata from the jsonl:
//   - tool NAMES        (tool_use block `.name`)
//   - file PATHS        (tool_use `.input.file_path` / `.path` / `.notebook_path`)
//   - command argv[0]   (first token of a Bash tool's `.input.command`)
//   - error flags       (`is_error`, `hookErrors`)
//   - git branch        (top-level `.gitBranch`)
//   - token counts      (`.message.usage`)
// It NEVER extracts or returns: any text block, user prompts, assistant
// replies, Write/Edit content (`new_string`/`old_string`/`content`), full
// Bash commands beyond argv[0], Grep patterns, or todo text. The privacy
// test asserts a unique secret planted in all of those never appears in the
// output. Keeps the "60-second audit" property of the metadata parser.

const ACTIVITY_TAIL_BYTES = 64 * 1024;
const MAX_TOOLS = 6;
const MAX_FILES = 10;
const PATH_KEYS = ["file_path", "path", "notebook_path"];

export async function parseSessionActivity(
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
  let gitBranch: string | undefined;
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

    const type = readString(obj.type);
    if (type && META_TYPES.has(type)) continue;

    if (!gitBranch) gitBranch = readString(obj.gitBranch);
    if (type === "assistant" || type === "user") turnCount++;

    if (obj.is_error === true || obj.error === true) lastError = "tool error";
    if (typeof obj.hookErrors === "number" && obj.hookErrors > 0) {
      lastError = `${obj.hookErrors} hook error(s)`;
    }

    const msg = obj.message;
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;

    const usage = m.usage;
    if (usage && typeof usage === "object") {
      const u = usage as Record<string, unknown>;
      inTok += toNum(u.input_tokens);
      outTok += toNum(u.output_tokens);
    }

    const content = m.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      // ONLY tool_use blocks. "text" blocks (prompts/replies) are skipped
      // entirely — we never read their `.text`.
      if (b.type !== "tool_use") continue;
      const name = readString(b.name);
      if (!name) continue;
      toolsInOrder.push(name);
      const input = b.input;
      if (!input || typeof input !== "object") continue;
      const inp = input as Record<string, unknown>;
      for (const k of PATH_KEYS) {
        const p = inp[k];
        if (typeof p === "string" && p) {
          files.push(p);
          break;
        }
      }
      if (name.toLowerCase() === "bash") {
        const cmd = inp.command;
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
    gitBranch,
    tokens: inTok || outTok ? { input: inTok, output: outTok } : undefined,
  };
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
