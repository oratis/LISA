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
  SessionActivity,
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

const ACTIVITY_MAX_FILES = 10;
const ACTIVITY_ERROR_CAP = 80;

// aider's diff edit format writes the file path on the line just before the
// fenced code block, e.g.
//     mathweb/flask/app.py
//     ```python
//     <<<<<<< SEARCH
// So a path "looks like" a bare token (no whitespace) that either contains a
// "/" or ends in a known source-file extension. This deliberately excludes
// prose, fence lines, and the diff markers themselves — we only ever surface
// the PATH, never a single byte of the SEARCH/REPLACE code body.
const PATHISH_RE =
  /^[\w.\-/@]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|md|json|ya?ml|toml|sh|c|h|cpp|hpp|java|rb|php|css|scss|html|sql)$|^[\w.\-/@]+\/[\w.\-/@]+$/;

// A line that opens/closes a fenced code block, optionally with a language tag.
const FENCE_RE = /^\s*(```|~~~)/;
// aider error lines — keep in sync with ERROR_RE but tuned for class extraction.
const ACTIVITY_ERROR_RE = /(litellm\.\w*error|\w*APIError|exception|error:)/i;

function looksLikePath(token: string): boolean {
  const t = token.trim().replace(/^`+|`+$/g, "").trim();
  if (!t || /\s/.test(t)) return false;
  return PATHISH_RE.test(t);
}

/**
 * Tier-2 structural activity for an Aider transcript. PURE — the unit under
 * test. Input is Markdown chat-history text (the observer feeds the same tail
 * it already read for state derivation, so there is no extra IO).
 *
 * Aider is a Markdown agent with NO structured tool calls, so we only extract
 * what's reliably present:
 *   - filesTouched: the path labels that precede SEARCH/REPLACE edit blocks.
 *   - turnCount:    "#### " user-turn lines.
 *   - lastError:    a short class summary of the last error line (capped).
 *   - lastTools:    INTENTIONALLY [] — aider has no tool abstraction to read,
 *                   so inventing tool names would be dishonest. See contract:
 *                   SessionActivity.lastTools may be [].
 * tokens / gitBranch / pendingPermission are unavailable here → undefined.
 *
 * PRIVACY: we surface only file PATHS, a turn count, and an error *class* — we
 * never read prompt text, assistant prose, or the code inside an edit block.
 */
export function parseAiderActivity(markdown: string): SessionActivity {
  const lines = markdown.split("\n");

  let turnCount = 0;
  const files: string[] = [];
  let lastError: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.startsWith("#### ")) turnCount++;

    // A SEARCH marker anchors an edit block. Walk backward past an optional
    // fence line to the nearest non-empty line, and keep it iff it's path-ish.
    // We read ONLY that path line — never the block body below the marker.
    if (/^\s*<{5,}\s*SEARCH\b/.test(line)) {
      let j = i - 1;
      while (j >= 0 && lines[j]!.trim() === "") j--;
      if (j >= 0 && FENCE_RE.test(lines[j]!)) {
        j--;
        while (j >= 0 && lines[j]!.trim() === "") j--;
      }
      if (j >= 0 && looksLikePath(lines[j]!)) {
        files.push(lines[j]!.trim().replace(/^`+|`+$/g, "").trim());
      }
    }

    if (ACTIVITY_ERROR_RE.test(line)) {
      lastError = summarizeError(line);
    }
  }

  return {
    turnCount,
    // Intentionally empty: aider exposes no tool calls (see doc above).
    lastTools: [],
    filesTouched: dedupeKeepRecent(files, ACTIVITY_MAX_FILES),
    lastError,
    // tokens / gitBranch / pendingPermission: not derivable from the transcript.
  };
}

/** Take just the error class/prefix from a noisy line; cap length, no stack. */
function summarizeError(line: string): string {
  // Strip aider's "> " info prefix, then keep up to the first sentence/segment
  // boundary so we surface the error class, not a full message or traceback.
  const stripped = line.replace(/^\s*>\s*/, "").trim();
  const head = stripped.split(/[—–\-]{1,2}\s|[.{[]|,\s/)[0]!.trim() || stripped;
  return head.slice(0, ACTIVITY_ERROR_CAP).trim();
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
  activity?: SessionActivity;
}

export class AiderObserver extends EventEmitter implements AgentObserver {
  readonly agent = "aider";
  private roots: string[];
  private sessions = new Map<string, AiderSessionInfo>();
  private watchers: fs.FSWatcher[] = [];
  private pending = new Map<string, NodeJS.Timeout>();
  private emitFn: ((s: AgentSession) => void) | null = null;
  private readonly computeActivity: boolean;

  constructor(cfg: AgentIntegrationConfig) {
    super();
    const raw = Array.isArray(cfg.watchRoots) ? cfg.watchRoots : [];
    this.roots = raw
      .filter((r): r is string => typeof r === "string")
      .map((r) => r.replace(/^~/, os.homedir()));
    // Tier 2: derive structural activity only at visibility "activity"/"intent".
    // At "metadata"/"off" we stay metadata-only (the privacy-minimal default).
    this.computeActivity =
      cfg.visibility === "activity" || cfg.visibility === "intent";
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
      // Single read: the same tail feeds both state derivation and (when the
      // tier is high enough) Tier-2 activity — no duplicate IO.
      const tail = await readTail(full);
      const { state, reason } = parseAiderState(tail);
      const cwd = path.dirname(full);
      this.sessions.set(full, {
        sessionId: full,
        project: path.basename(cwd),
        cwd,
        lastMtime: st.mtimeMs,
        state,
        stateReason: reason,
        activity: this.computeActivity ? parseAiderActivity(tail) : undefined,
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
    activity: i.activity,
  };
}

registerIntegration("aider", (cfg) => new AiderObserver(cfg));
