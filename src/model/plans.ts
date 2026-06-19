/**
 * Coding-plan backends (CODING_PLANS.md, Phase 1 — detection + picker).
 *
 * A "coding plan" is a flat-rate subscription (Claude Pro/Max, a ChatGPT plan
 * via Codex, GitHub Copilot) that the user already pays for. LISA can spend that
 * budget on *coding work* by DELEGATING to the vendor's own CLI — never by
 * extracting or replaying its subscription token (Anthropic's terms forbid that,
 * and enforced it against OpenClaw; see docs/CODING_PLANS.md).
 *
 * This module is the Phase-1 slice: *detect* which plan CLIs are installed /
 * logged in, and *select* one as the default delegation target. It performs NO
 * authentication and reads NO secrets — detection is presence-only (binary on
 * PATH / credential file exists), exactly the metadata-not-payload posture of
 * every LISA observer. Actually routing coding work to the selected plan is a
 * later phase that builds on the existing PTY bridge (src/agents/pty.ts).
 *
 * The probe (filesystem / PATH / env) is injectable so detection is unit-testable
 * without a real claude/codex install.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type PlanId = "claude" | "codex" | "copilot";

export const PLAN_IDS: readonly PlanId[] = ["claude", "codex", "copilot"];

export interface PlanStatus {
  id: PlanId;
  /** Human label, e.g. "Claude Pro/Max". */
  label: string;
  /** The vendor CLI that owns this plan's auth. */
  cli: string;
  /** Resolved binary path/name, or null if not found. */
  binary: string | null;
  /** Is the CLI installed (binary present)? */
  available: boolean;
  /**
   * Best-effort login signal from credential *presence* (never contents):
   * true = a credential file / token env was found, false = looked and found
   * none, null = can't tell (e.g. macOS Keychain — opaque without reading it).
   */
  loggedIn: boolean | null;
  /** Short human hint about state / how to enable. */
  detail: string;
}

/** Injectable view of the host used for presence-only detection. Pure inputs. */
export interface PlanProbe {
  home: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** Does a file/dir exist at this absolute path? */
  exists(p: string): boolean;
  /** Directory entries, or [] on any error. */
  readdir(p: string): string[];
  /** Is `cmd` an executable on PATH (or an existing absolute path)? */
  onPath(cmd: string): boolean;
}

/** The real host probe (filesystem + PATH + env). */
export function defaultPlanProbe(): PlanProbe {
  const env = process.env as Record<string, string | undefined>;
  return {
    home: homedir(),
    platform: process.platform,
    env,
    exists: (p) => {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    },
    readdir: (p) => {
      try {
        return readdirSync(p);
      } catch {
        return [];
      }
    },
    onPath: (cmd) => onPath(cmd, env),
  };
}

/** Is `cmd` resolvable on PATH? Absolute/relative paths are checked directly. Pure-ish. */
export function onPath(cmd: string, env: Record<string, string | undefined>): boolean {
  if (cmd.includes("/") || cmd.includes("\\")) {
    try {
      return existsSync(cmd);
    } catch {
      return false;
    }
  }
  const isWin = process.platform === "win32";
  const sep = isWin ? ";" : ":";
  const exts = isWin ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of (env.PATH ?? "").split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        if (existsSync(join(dir, cmd + ext))) return true;
      } catch {
        /* unreadable dir → skip */
      }
    }
  }
  return false;
}

/** Parse a `plan://<id>` reference into a known PlanId, else null. Pure. */
export function parsePlanRef(ref: string): PlanId | null {
  const m = ref.match(/^plan:\/\/(.+)$/i);
  if (!m) return null;
  const id = m[1]!.trim().toLowerCase();
  return (PLAN_IDS as readonly string[]).includes(id) ? (id as PlanId) : null;
}

/** Currently selected coding-plan delegation target, if any (LISA_CODING_PLAN). */
export function selectedPlan(env: Record<string, string | undefined> = process.env): PlanId | null {
  const v = (env.LISA_CODING_PLAN ?? "").trim().toLowerCase();
  return (PLAN_IDS as readonly string[]).includes(v) ? (v as PlanId) : null;
}

// ── per-plan detection (presence-only) ───────────────────────────────────────

function cmpVersionDesc(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pb[i] || 0) !== (pa[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
  return 0;
}

/** Newest app-bundled `claude` binary on macOS (mirrors pty.detectClaudeBinary). */
function claudeAppBundle(probe: PlanProbe): string | null {
  if (probe.platform !== "darwin") return null;
  const root = join(probe.home, "Library", "Application Support", "Claude", "claude-code");
  const versions = probe.readdir(root).filter((v) => /^\d+\.\d+\.\d+/.test(v)).sort(cmpVersionDesc);
  for (const v of versions) {
    const bin = join(root, v, "claude.app", "Contents", "MacOS", "claude");
    if (probe.exists(bin)) return bin;
  }
  return null;
}

function detectClaude(probe: PlanProbe): PlanStatus {
  const override = probe.env.LISA_PTY_CLAUDE_CMD;
  const binary = override
    ? probe.onPath(override)
      ? override
      : null
    : (claudeAppBundle(probe) ?? (probe.onPath("claude") ? "claude" : null));

  // Login: token env, else credentials file (Linux/Windows). On macOS the creds
  // live in the Keychain (opaque) → unknown rather than "logged out".
  const configDir = probe.env.CLAUDE_CONFIG_DIR
    ? probe.env.CLAUDE_CONFIG_DIR
    : join(probe.home, ".claude");
  let loggedIn: boolean | null;
  if (probe.env.CLAUDE_CODE_OAUTH_TOKEN || probe.env.ANTHROPIC_AUTH_TOKEN) loggedIn = true;
  else if (probe.exists(join(configDir, ".credentials.json"))) loggedIn = true;
  else if (probe.platform === "darwin") loggedIn = null; // Keychain — can't tell from presence
  else loggedIn = false;

  return {
    id: "claude",
    label: "Claude Pro/Max",
    cli: "claude",
    binary,
    available: binary !== null,
    loggedIn,
    detail: hint(binary !== null, loggedIn, "claude", "`claude` (Claude Code)"),
  };
}

function detectCodex(probe: PlanProbe): PlanStatus {
  const cli = probe.env.LISA_PTY_CODEX_CMD || "codex";
  const binary = probe.onPath(cli) ? cli : null;
  const codexHome = probe.env.CODEX_HOME ? probe.env.CODEX_HOME : join(probe.home, ".codex");
  // auth.json exists → logged in. Absent could mean OS-keyring storage → unknown.
  const loggedIn = probe.exists(join(codexHome, "auth.json")) ? true : binary ? null : false;
  return {
    id: "codex",
    label: "ChatGPT plan (Codex)",
    cli: "codex",
    binary,
    available: binary !== null,
    loggedIn,
    detail: hint(binary !== null, loggedIn, "codex", "`codex` (OpenAI Codex)"),
  };
}

function detectCopilot(probe: PlanProbe): PlanStatus {
  // The delegate target is the standalone agentic `copilot` CLI, which runs a
  // task non-interactively via `copilot -p "<task>"`. The older `gh copilot`
  // (suggest/explain) is NOT agentic and can't run a task, so it doesn't count.
  const binary = probe.onPath("copilot") ? "copilot" : null;
  // Copilot login sits behind GitHub auth — not cheaply checkable without
  // spawning, so: installed → unknown, absent → false.
  const loggedIn = binary ? null : false;
  return {
    id: "copilot",
    label: "GitHub Copilot",
    cli: "copilot",
    binary,
    available: binary !== null,
    loggedIn,
    detail: binary
      ? "installed — login state unknown (GitHub auth)"
      : "install the GitHub Copilot CLI (`copilot`) to enable",
  };
}

function hint(available: boolean, loggedIn: boolean | null, loginCmd: string, what: string): string {
  if (!available) return `install ${what} to enable`;
  if (loggedIn === true) return "ready";
  if (loggedIn === false) return `installed — run \`${loginCmd} login\` to sign in`;
  return "installed — login state unknown (stored in the OS keychain)";
}

/** Detect one plan's status. */
export function detectPlan(id: PlanId, probe: PlanProbe = defaultPlanProbe()): PlanStatus {
  switch (id) {
    case "claude":
      return detectClaude(probe);
    case "codex":
      return detectCodex(probe);
    case "copilot":
      return detectCopilot(probe);
  }
}

/** Detect every known plan. */
export function detectPlans(probe: PlanProbe = defaultPlanProbe()): PlanStatus[] {
  return PLAN_IDS.map((id) => detectPlan(id, probe));
}

// ── delegation (CODING_PLANS Phase 2) ────────────────────────────────────────

/**
 * The headless dispatch CLI kind a plan delegates through. Each plan id is also
 * its CLI kind in launchAgent: claude → `claude -p`, codex → `codex exec`,
 * copilot → `copilot -p`.
 */
export function planDispatchKind(id: PlanId): "claude" | "codex" | "copilot" {
  return id; // each plan id is also its headless dispatch CLI kind
}

export interface PlanPreflight {
  ok: boolean;
  /** Why delegation can't proceed (only when ok=false). */
  reason?: string;
}

/**
 * Can we delegate coding work to this detected plan right now? Pure. A null
 * (unknown) login passes — on macOS the credential lives in the Keychain and
 * "installed but login unverifiable" should not block; the CLI itself will
 * prompt if truly logged out.
 */
export function planPreflight(status: PlanStatus): PlanPreflight {
  if (!status.available) return { ok: false, reason: `${status.cli} isn't installed — ${status.detail}` };
  if (status.loggedIn === false)
    return { ok: false, reason: `${status.cli} is installed but not logged in — ${status.detail}` };
  return { ok: true };
}
