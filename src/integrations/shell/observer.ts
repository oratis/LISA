/**
 * Shell observer (Sense S1c — what the user runs at the terminal).
 *
 * Tails the shell history file(s) and surfaces ONLY which programs were run
 * (argv[0] — "git", "npm", "docker", "ssh") plus counts/recency. This widens
 * Sense to the user's command-line rhythm without an agent involved.
 *
 * PRIVACY (the whole point of this adapter): it extracts the PROGRAM NAME ONLY.
 * Never a full command line, never arguments, never paths, never the contents
 * of `git commit -m "..."`. A planted-secret test asserts this. Off by default
 * — shell history is sensitive; opt in via ~/.lisa/agents.json.
 *
 * Mapping to a session (a shell isn't an "agent"): one session per history
 * file, project = the shell name ("zsh"/"bash"), state = "working" while there
 * was recent activity (older ones drop out of the active window). cwd is
 * unavailable (history records no directory), so it's omitted.
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

const ACTIVE_WINDOW_MS = 30 * 60_000; // 30m
const DEBOUNCE_MS = 500;
const TAIL_BYTES = 16 * 1024;
const ACTIVITY_MAX = 40; // how many recent commands to consider
const LAST_TOOLS_MAX = 8;

/**
 * Extract argv[0] (the program name) from one history command line. Pure.
 * Strips leading `VAR=val` assignments, takes the first token, basenames it,
 * and returns null for anything that isn't a plain command name (flags, shell
 * syntax). Deliberately surfaces ONLY the program name — nothing after it.
 */
export function extractArgv0(command: string): string | null {
  let s = command.trim();
  if (!s || s.startsWith("#")) return null;
  // Drop leading environment assignments: FOO=bar BAZ="x" cmd ...
  s = s.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, "");
  // Drop a leading subshell/grouping paren so "(cd x && y)" doesn't leak "(cd".
  s = s.replace(/^[({]\s*/, "");
  const tok = s.split(/\s+/)[0];
  if (!tok) return null;
  const base = (tok.split("/").pop() || tok).trim();
  // Only a plausible program name — excludes flags, redirects, var expansions.
  if (!base || !/^[A-Za-z0-9._@+-]+$/.test(base) || base.startsWith("-")) return null;
  return base;
}

/**
 * Parse a shell-history tail into a list of argv[0]s (program names only).
 * Handles zsh EXTENDED_HISTORY (": <ts>:<elapsed>;<cmd>") and bash
 * HISTTIMEFORMAT ("#<epoch>" lines) as well as plain command-per-line. Pure.
 */
export function parseHistoryArgv0s(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (/^#\d+$/.test(trimmed)) continue; // bash timestamp comment line
    const zsh = line.match(/^: \d+:\d+;(.*)$/); // zsh extended-history prefix
    const cmd = zsh ? zsh[1]! : line;
    const a = extractArgv0(cmd);
    if (a) out.push(a);
  }
  return out;
}

function dedupeKeepRecent(items: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    if (!seen.has(items[i]!)) {
      seen.add(items[i]!);
      out.unshift(items[i]!);
    }
  }
  return out.slice(-max);
}

/** Tier-2 structural activity from recent argv[0]s. Program names + counts only. Pure. */
export function shellActivity(argv0s: string[]): SessionActivity {
  const recent = argv0s.slice(-ACTIVITY_MAX);
  return {
    turnCount: argv0s.length,
    lastTools: dedupeKeepRecent(recent, LAST_TOOLS_MAX),
    filesTouched: [], // shell history carries no file info we'd surface
    lastCommandName: recent[recent.length - 1],
  };
}

function deriveShellState(lastMtime: number, now: number): { state: AgentSessionState; reason: string } {
  return now - lastMtime < ACTIVE_WINDOW_MS
    ? { state: "working", reason: "recent commands" }
    : { state: "idle", reason: "quiet" };
}

async function readTail(file: string): Promise<string> {
  const st = await fsp.stat(file);
  if (st.size === 0) return "";
  const fd = await fsp.open(file, "r");
  try {
    const len = Math.min(TAIL_BYTES, st.size);
    const buf = Buffer.alloc(len);
    await fd.read(buf, 0, len, st.size - len);
    // latin1 avoids throwing on the non-UTF8 bytes zsh can write; we only ever
    // keep ASCII program names out of it anyway.
    return buf.toString("latin1");
  } finally {
    await fd.close();
  }
}

/** Default history files to watch when none are configured. */
function defaultHistoryFiles(): string[] {
  const home = os.homedir();
  return [path.join(home, ".zsh_history"), path.join(home, ".bash_history")];
}

interface ShellSessionInfo {
  sessionId: string;
  project: string;
  lastMtime: number;
  state: AgentSessionState;
  stateReason: string;
  activity?: SessionActivity;
}

export class ShellObserver extends EventEmitter implements AgentObserver {
  readonly agent = "shell";
  private files: string[];
  private sessions = new Map<string, ShellSessionInfo>();
  private watchers: fs.FSWatcher[] = [];
  private pending = new Map<string, NodeJS.Timeout>();
  private emitFn: ((s: AgentSession) => void) | null = null;
  private readonly computeActivity: boolean;

  constructor(cfg: AgentIntegrationConfig) {
    super();
    const raw = Array.isArray(cfg.files) ? (cfg.files as unknown[]) : null;
    this.files = (raw ?? defaultHistoryFiles())
      .filter((f): f is string => typeof f === "string")
      .map((f) => f.replace(/^~/, os.homedir()));
    this.computeActivity = cfg.visibility === "activity" || cfg.visibility === "intent";
  }

  async start(emit: (s: AgentSession) => void): Promise<void> {
    this.emitFn = emit;
    for (const file of this.files) {
      await this.record(file);
      this.attach(file);
    }
  }

  list(): AgentSession[] {
    const cutoff = Date.now() - ACTIVE_WINDOW_MS;
    return [...this.sessions.values()]
      .filter((s) => s.lastMtime >= cutoff)
      .sort((a, b) => b.lastMtime - a.lastMtime)
      .map(toAgentSession);
  }

  async stop(): Promise<void> {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  private attach(file: string): void {
    try {
      const w = fs.watch(file, { persistent: false }, () => {
        const prev = this.pending.get(file);
        if (prev) clearTimeout(prev);
        this.pending.set(
          file,
          setTimeout(() => {
            this.pending.delete(file);
            void this.record(file).then(() => {
              const info = this.sessions.get(file);
              if (info && this.emitFn) this.emitFn(toAgentSession(info));
            });
          }, DEBOUNCE_MS),
        );
      });
      w.on("error", () => w.close());
      this.watchers.push(w);
    } catch {
      // file unwatchable (e.g. doesn't exist) → no-op
    }
  }

  private async record(file: string): Promise<void> {
    try {
      const st = await fsp.stat(file);
      if (!st.isFile()) return;
      const tail = await readTail(file);
      const argv0s = parseHistoryArgv0s(tail);
      const { state, reason } = deriveShellState(st.mtimeMs, Date.now());
      this.sessions.set(file, {
        sessionId: file,
        project: shellName(file),
        lastMtime: st.mtimeMs,
        state,
        stateReason: reason,
        activity: this.computeActivity ? shellActivity(argv0s) : undefined,
      });
    } catch {
      this.sessions.delete(file); // file vanished
    }
  }
}

function shellName(file: string): string {
  const base = path.basename(file); // .zsh_history / .bash_history
  if (base.includes("zsh")) return "zsh";
  if (base.includes("bash")) return "bash";
  if (base.includes("fish")) return "fish";
  return "shell";
}

function toAgentSession(i: ShellSessionInfo): AgentSession {
  return {
    agent: "shell",
    sessionId: i.sessionId,
    project: i.project,
    state: i.state,
    stateReason: i.stateReason,
    lastMtime: i.lastMtime,
    activity: i.activity,
  };
}

registerIntegration("shell", (cfg) => new ShellObserver(cfg));
