/**
 * PTY-backed agents — EXPERIMENTAL spike (Stage C), OFF BY DEFAULT.
 *
 * Phase-3 managed agents run LISA's OWN agent loop (its tools, its provider).
 * A PTY agent instead spawns the REAL `claude` / `codex` CLI inside a
 * pseudo-terminal, so you get that tool's full configuration — its skills, MCP
 * servers, hooks, model — while LISA owns stdin/stdout: it types your task and
 * follow-ups, can answer prompts, and reads the stream for a coarse live status.
 *
 * HONEST LIMITS (why this is a flagged spike, not a shipped feature):
 *  - Native dep: needs `node-pty` (an *optional* dependency). If it isn't built,
 *    PTY agents are simply unavailable — nothing else in LISA changes.
 *  - Off by default: set `LISA_PTY_AGENTS=1` to enable.
 *  - Controls only CLIs LISA SPAWNS — NOT sessions you already opened in your
 *    own terminal (those have no control channel; they stay observe-only).
 *  - Output parsing is best-effort: the CLI's TUI is ANSI / box-drawn and
 *    version-sensitive, so "state" is inferred from output quiescence, not from
 *    parsed intent. The captured tail is shown to you (your own terminal), never
 *    folded into the structural cross-agent roster.
 */
import { EventEmitter } from "node:events";
import { readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type PtyState = "working" | "waiting" | "error" | "done";

/** Public, serializable snapshot of a PTY agent (structural — no output text). */
export interface PtyView {
  id: string;
  /** Normalized roster kind, e.g. "claude-code" | "codex". */
  agent: string;
  /** The spawned binary, e.g. "claude". */
  cli: string;
  project: string;
  cwd: string;
  state: PtyState;
  stateReason: string;
  lastMtime: number;
  /** Bytes of terminal output seen so far — a rough liveness signal. */
  bytesOut: number;
  /** When this PTY is a resume-adopt, the real claude session id it continues
   *  (so the roster can drop the observe-only duplicate of the same session). */
  adoptedSessionId?: string;
}

export interface PtyStartOpts {
  /** "claude" | "claude-code" | "codex" | … */
  agent: string;
  task: string;
  cwd: string;
  /**
   * Adopt an EXISTING claude session by id — spawns `claude --resume <id>` so
   * LISA drives a continuation of a session the user started elsewhere. The
   * caller MUST ensure the session is idle (see liveClaudeSessionIds) — resuming
   * a live one corrupts its transcript.
   */
  resumeSessionId?: string;
  /** Override the binary (else resolved from `agent`). */
  cli?: string;
  /** Override argv (else interactive: []). */
  args?: string[];
  cols?: number;
  rows?: number;
  /** Clock override (tests). */
  now?: () => number;
  /** Injected pty module (tests) — avoids spawning a real process. */
  ptyModule?: PtyModuleLike;
}

// ── minimal node-pty surface (so this file needs no compile-time dep on its
//    types — node-pty is optional and may be absent when `tsc` runs) ──
export interface IPtyLike {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  kill(signal?: string): void;
}
export interface PtyModuleLike {
  spawn(
    file: string,
    args: string[],
    opts: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string | undefined>;
    },
  ): IPtyLike;
}

/** Is the PTY-agent spike enabled? Off unless LISA_PTY_AGENTS=1. */
export function ptyEnabled(): boolean {
  return process.env.LISA_PTY_AGENTS === "1";
}

/** Map a roster agent-kind to its CLI binary (env-overridable). */
export function resolveCli(agent: string): string {
  const a = agent.toLowerCase();
  if (a === "codex") return process.env.LISA_PTY_CODEX_CMD || "codex";
  // default to claude (covers "claude" / "claude-code")
  return process.env.LISA_PTY_CLAUDE_CMD || "claude";
}

/** Normalize a loose agent label to a roster AgentKind. */
export function normalizeAgentKind(agent: string): string {
  const a = agent.toLowerCase();
  if (a === "codex") return "codex";
  if (a === "claude" || a === "claude-code") return "claude-code";
  return agent;
}

/**
 * Best binary to drive a claude session: env override → the newest app-bundled
 * claude (matches the version that wrote the sessions, best for --resume) → the
 * PATH `claude`. The app-bundle probe is macOS-specific and silently no-ops
 * elsewhere. Falls back to resolveCli for non-claude agents.
 */
export function detectClaudeBinary(): string {
  if (process.env.LISA_PTY_CLAUDE_CMD) return process.env.LISA_PTY_CLAUDE_CMD;
  try {
    const root = join(homedir(), "Library", "Application Support", "Claude", "claude-code");
    const versions = readdirSync(root)
      .filter((v) => /^\d+\.\d+\.\d+/.test(v))
      .sort((a, b) => cmpVersion(b, a)); // newest first
    for (const v of versions) {
      const bin = join(root, v, "claude.app", "Contents", "MacOS", "claude");
      if (existsSync(bin)) return bin;
    }
  } catch {
    /* not macOS / not installed → fall through */
  }
  return "claude";
}

function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// Strip ANSI / VT100 escape sequences so the captured tail is plain-ish text.
// Control anchors come via String.fromCharCode so the SOURCE carries no raw
// control bytes (which trip greps, diffs, and some editors).
const ESC = String.fromCharCode(27); // U+001B
const CSI = String.fromCharCode(155); // U+009B
const BEL = String.fromCharCode(7); // U+0007
const ANSI = new RegExp(
  "[" + ESC + CSI + "][[\\]()#;?]*" +
    "(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?" +
    BEL +
    ")|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))",
  "g",
);

/** Strip ANSI escape sequences + common bare control bytes (CR/backspace). Pure. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(ANSI, "").replace(/[\r\b]/g, "");
}

/**
 * Coarse live state from output quiescence: actively streaming ⇒ "working";
 * quiet longer than idleMs ⇒ "waiting" (likely awaiting input or a prompt).
 * `done`/`error` are decided by lifecycle flags, not here. Pure.
 */
export function derivePtyState(lastChunkAtMs: number, nowMs: number, idleMs: number): PtyState {
  return nowMs - lastChunkAtMs < idleMs ? "working" : "waiting";
}

const RING_MAX = 4000; // chars of ANSI-stripped tail kept
const IDLE_MS = 4000; // quiet longer than this ⇒ "waiting"

let counter = 0;

async function loadPty(): Promise<PtyModuleLike | null> {
  try {
    // Non-literal specifier so `tsc` treats this as `any` and never hard-requires
    // node-pty (it's an optionalDependency that may be absent). Resolved at runtime.
    const spec: string = "node-pty";
    const mod: { spawn?: unknown; default?: unknown } = await import(spec);
    const resolved =
      mod && typeof mod.spawn === "function" ? mod : ((mod && mod.default) ?? mod);
    return resolved as PtyModuleLike;
  } catch {
    return null;
  }
}

/** One real CLI running under a pseudo-terminal that LISA drives. */
export class PtyAgent {
  readonly id: string;
  readonly agent: string;
  readonly cli: string;
  readonly cwd: string;
  readonly project: string;
  /** Real claude session id, when this agent is a resume-adopt (claude only). */
  readonly adoptedSessionId?: string;
  onChange: () => void = () => {};
  /** Called with each ANSI-stripped output chunk — drives the live attach stream
   *  (GET /api/agents/pty/<id>/stream). Distinct from onChange (state snapshots). */
  onOutput: (chunk: string) => void = () => {};

  private readonly proc: IPtyLike;
  private readonly now: () => number;
  private ring = "";
  private bytesOut = 0;
  private aborted = false;
  private exited = false;
  private exitReason = "";
  private lastChunkAt: number;
  private lastMtime: number;

  private constructor(id: string, opts: PtyStartOpts, cli: string, proc: IPtyLike, now: () => number) {
    this.id = id;
    this.agent = normalizeAgentKind(opts.agent);
    this.cli = cli;
    this.cwd = opts.cwd;
    this.project = opts.cwd.split("/").filter(Boolean).pop() || opts.cwd;
    this.adoptedSessionId =
      opts.resumeSessionId && this.agent === "claude-code" ? opts.resumeSessionId : undefined;
    this.proc = proc;
    this.now = now;
    this.lastChunkAt = now();
    this.lastMtime = now();
    proc.onData((d) => this.onData(d));
    proc.onExit((e) => this.onExit(e));
  }

  /** Spawn a real CLI under a PTY and type the initial task. */
  static async start(opts: PtyStartOpts): Promise<PtyAgent> {
    if (!ptyEnabled()) {
      throw new Error("PTY agents are disabled — set LISA_PTY_AGENTS=1 to enable this spike");
    }
    const pty = opts.ptyModule ?? (await loadPty());
    if (!pty) {
      throw new Error("node-pty is not installed — run `npm i node-pty` to enable PTY agents");
    }
    const kind = normalizeAgentKind(opts.agent);
    // Resume-adopt is claude-only. The codex CLI *does* support `codex resume
    // <id>`, but LISA can't adopt it SAFELY: unlike claude (which writes
    // ~/.claude/sessions/<pid>.json), codex leaves no liveness signal, so we
    // can't tell whether a rollout is idle vs. open right now — and resuming a
    // live session double-writes its transcript and corrupts it. Refuse rather
    // than silently dropping the id and spawning a fresh session. See
    // docs/PTY_AGENTS.md ("Why codex resume-adopt isn't supported (yet)").
    if (opts.resumeSessionId && kind !== "claude-code") {
      throw new Error(
        `resume-adopt is only supported for claude sessions (got "${opts.agent}") — ` +
          "codex has no liveness signal to guard against transcript corruption",
      );
    }
    const cli = opts.cli ?? (kind === "claude-code" ? detectClaudeBinary() : resolveCli(opts.agent));
    // Adopt an existing session by id: `claude --resume <id>` (claude-only, guarded above).
    const resumeArgs = opts.resumeSessionId ? ["--resume", opts.resumeSessionId] : [];
    const args = [...resumeArgs, ...(opts.args ?? [])];
    const now = opts.now ?? Date.now;
    const proc = pty.spawn(cli, args, {
      name: "xterm-256color",
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 32,
      cwd: opts.cwd,
      env: process.env,
    });
    const id = "p" + (++counter).toString(36) + "-" + Date.now().toString(36).slice(-4);
    const agent = new PtyAgent(id, opts, cli, proc, now);
    if (opts.task) agent.send(opts.task);
    return agent;
  }

  /** Type a line into the CLI (initial task or a follow-up). */
  send(text: string): void {
    if (this.aborted || this.exited) return;
    this.proc.write(text + "\r");
    this.touch();
  }

  /** Kill the CLI. Idempotent. */
  cancel(): void {
    if (this.exited) return;
    this.aborted = true;
    try {
      this.proc.kill();
    } catch {
      /* already gone */
    }
    this.exitReason = "cancelled";
    this.touch();
  }

  /**
   * ANSI-stripped tail of the terminal — the user's window into THEIR agent.
   * Exposed only via an explicit endpoint, never folded into the structural
   * cross-agent roster (which stays metadata-only).
   */
  output(): string {
    return this.ring;
  }

  view(): PtyView {
    let state: PtyState;
    let reason: string;
    if (this.aborted) {
      state = "done";
      reason = "cancelled";
    } else if (this.exited) {
      state = "done";
      reason = this.exitReason || "exited";
    } else {
      state = derivePtyState(this.lastChunkAt, this.now(), IDLE_MS);
      reason = state === "working" ? "streaming" : "idle";
    }
    return {
      id: this.id,
      agent: this.agent,
      cli: this.cli,
      project: this.project,
      cwd: this.cwd,
      state,
      stateReason: reason,
      lastMtime: this.lastMtime,
      bytesOut: this.bytesOut,
      ...(this.adoptedSessionId ? { adoptedSessionId: this.adoptedSessionId } : {}),
    };
  }

  // ── internals ──
  private onData(d: string): void {
    this.bytesOut += d.length;
    const clean = stripAnsi(d);
    this.ring = (this.ring + clean).slice(-RING_MAX);
    this.lastChunkAt = this.now();
    if (clean) this.onOutput(clean);
    this.touch();
  }

  private onExit(e: { exitCode: number }): void {
    this.exited = true;
    if (!this.exitReason) this.exitReason = "exit " + e.exitCode;
    this.touch();
  }

  private touch(): void {
    this.lastMtime = this.now();
    this.onChange();
  }
}

/** Process-wide registry of PTY agents; emits "update" with a PtyView. */
export class PtyRegistry extends EventEmitter {
  private agents = new Map<string, PtyAgent>();

  async start(opts: PtyStartOpts): Promise<PtyView> {
    const a = await PtyAgent.start(opts);
    a.onChange = () => this.emit("update", a.view());
    a.onOutput = (chunk) => this.emit("output", { id: a.id, chunk });
    this.agents.set(a.id, a);
    this.emit("update", a.view());
    return a.view();
  }

  send(id: string, text: string): boolean {
    const a = this.agents.get(id);
    if (!a) return false;
    a.send(text);
    return true;
  }

  cancel(id: string): boolean {
    const a = this.agents.get(id);
    if (!a) return false;
    a.cancel();
    return true;
  }

  /** ANSI-stripped tail of a PTY agent's terminal, or null if unknown. */
  output(id: string): string | null {
    return this.agents.get(id)?.output() ?? null;
  }

  get(id: string): PtyAgent | undefined {
    return this.agents.get(id);
  }

  list(): PtyView[] {
    return [...this.agents.values()].map((a) => a.view());
  }
}

export const ptyRegistry = new PtyRegistry();
