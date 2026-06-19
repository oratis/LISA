/**
 * Cross-agent orchestration — shared types.
 *
 * LISA observes many CLI agents (Claude Code, Codex, OpenCode, Aider, …),
 * each with its own on-disk session format. These types are the normalized,
 * agent-agnostic shape every adapter produces, so the UI, the hub, and the
 * advisor never care which agent a session came from.
 *
 * See docs/ORCHESTRATOR_PLAN.md for the full design (L1 OBSERVE, L2 UNDERSTAND).
 */

/** Which agent produced a session. Open-ended string so community adapters
 *  can add kinds without touching this file. */
export type AgentKind =
  | "claude-code"
  | "codex"
  | "opencode"
  | "aider"
  | "gemini"
  | "cursor"
  | "github-pr"
  | "mcp"
  | "lisa"
  | (string & {});

/** Normalized session state across all agents. Superset of any single
 *  agent's states; adapters map their native states onto these. */
export type AgentSessionState =
  | "working" // mid-turn, actively progressing
  | "waiting" // finished a turn / awaiting user or a permission decision
  | "error" // last meaningful activity errored
  | "idle" // tracked but no recent activity
  | "done" // session concluded (PR opened, exit, etc.)
  | "unknown";

/**
 * L2 — structural activity for a session. Populated by tier ≥ "activity"
 * adapters. PRIVACY: every field here is structural metadata (tool NAMES,
 * file PATHS, command argv[0], error strings, counts) — never a prompt, a
 * model reply, or full command arguments. See parser privacy tests.
 */
export interface SessionActivity {
  /** Number of assistant/user turns observed (rough progress indicator). */
  turnCount: number;
  /** Most recent tool names, newest last, e.g. ["Read","Edit","Bash"]. */
  lastTools: string[];
  /** File paths touched by Edit/Write-style tools (deduped, capped). */
  filesTouched: string[];
  /** argv[0] of the most recent shell command, e.g. "npm" — not the full command. */
  lastCommandName?: string;
  /** Short error summary if the last meaningful activity errored. */
  lastError?: string;
  /** git branch recorded by the agent, if any. */
  gitBranch?: string;
  /** Token usage so far (for cost-spike detection). */
  tokens?: { input: number; output: number };
  /** Tool name awaiting a permission decision, if the session is blocked on one. */
  pendingPermission?: string;
}

/**
 * One normalized session. The merge target for every adapter's output.
 */
export interface AgentSession {
  agent: AgentKind;
  /** Stable id within this agent (uuid, rollout filename, PR number, …). */
  sessionId: string;
  /** Human label — usually the basename of cwd. */
  project: string;
  cwd?: string;
  state: AgentSessionState;
  /** Short machine-ish reason for the state ("end_turn", "permission", …). */
  stateReason: string;
  /** Last activity time, epoch ms. */
  lastMtime: number;
  /** L2 activity, present when the adapter runs at tier ≥ "activity". */
  activity?: SessionActivity;
  /**
   * If LISA can CONTROL this session (not just observe it), which control-endpoint
   * family drives it: POST /api/agents/<controllable>/<sessionId>/{send,cancel,…}.
   *  - "managed" — LISA runs the agent loop itself (send/cancel/approve).
   *  - "pty"     — a real CLI LISA spawned under a pseudo-terminal (send/cancel).
   * Absent ⇒ observe-only (an externally-started CLI; no control channel).
   */
  controllable?: "managed" | "pty";
  /**
   * Observe-only claude session that LISA can ADOPT — it's idle (its process is
   * gone), so `claude --resume <sessionId>` can safely continue it under LISA's
   * control. Set by the API layer for claude-code sessions not currently live.
   */
  resumable?: boolean;
  /** When a controllable PTY is a resume-adopt, the real claude sessionId it
   *  continues — lets the roster drop the observe-only duplicate of that session. */
  adoptedSessionId?: string;
}

/** Visibility tier — how deeply LISA may inspect a session. See plan §3. */
export type VisibilityTier = "off" | "metadata" | "activity" | "intent";

/** Per-integration config from ~/.lisa/agents.json. */
export interface AgentIntegrationConfig {
  enabled?: boolean;
  /** Home dir / data dir override (e.g. CODEX_HOME, OPENCODE_DATA_DIR). */
  home?: string;
  /** Extra roots to watch (e.g. Aider's per-project logs). */
  watchRoots?: string[];
  /** Per-integration visibility override; falls back to the global tier. */
  visibility?: VisibilityTier;
  /** Arbitrary adapter-specific options. */
  [k: string]: unknown;
}

/**
 * An adapter that watches one agent kind and emits normalized sessions.
 * Stateful: holds file watchers / timers between start() and stop().
 */
export interface AgentObserver {
  readonly agent: AgentKind;
  /** Begin watching. `emit` is called on every new/changed session. */
  start(emit: (session: AgentSession) => void): Promise<void>;
  /** Current snapshot of active sessions. */
  list(): AgentSession[];
  /** Tear down watchers/timers. Idempotent. */
  stop(): Promise<void>;
}

export type AgentObserverFactory = (
  cfg: AgentIntegrationConfig,
) => AgentObserver | Promise<AgentObserver>;
