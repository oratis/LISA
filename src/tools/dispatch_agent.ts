/**
 * dispatch_agent (L3 DISPATCH) — LISA launches another CLI agent with a task
 * and tracks it, turning observation into orchestration.
 *
 * Each supported agent has a non-interactive ("headless") invocation:
 *   claude    → claude -p "<task>"
 *   codex     → codex exec "<task>"
 *   opencode  → opencode run "<task>"
 *   aider     → aider --message "<task>" --yes
 *   copilot   → copilot -p "<task>"
 *   cursor    → agent -p "<task>" / cursor-agent -p "<task>" (or LISA_CURSOR_CMD)
 *   gemini    → gemini -p "<task>" (or LISA_GEMINI_CLI_CMD)
 *
 * The agent is spawned detached so it keeps running independently; it then
 * shows up in the orchestrator hub via its normal session file (the same
 * path the observers already watch). This tool returns immediately with a
 * handle — it does NOT block on completion.
 *
 * SAFETY: spawning an autonomous agent is an explicit-permission action
 * (it can read/write files + run commands). The tool surfaces the exact
 * argv it will run; the host's approval layer (ToolContext.onObjection /
 * the approval mode) gates it. The task string is passed as a single argv
 * element — never interpolated into a shell — so there's no shell-injection
 * surface (same lesson as the iMessage argv fix).
 */

import { detectPlan, findExecutable } from "../model/plans.js";
import { spawn } from "node:child_process";
import { childEnv } from "../child-env.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ToolDefinition } from "../types.js";
import { getCurrentHub } from "../integrations/current-hub.js";
import {
  acquireCwdLock,
  listActiveCwdLocks,
  releaseCwdLock,
  resolveCwdRealpath,
  updateCwdLock,
  type CwdLockInfo,
} from "../integrations/cwd-lock.js";
import {
  recordDispatch,
  recordExit,
  dispatchLogDir,
  processStartToken,
} from "../integrations/dispatch-ledger.js";
import {
  DISPATCH_BACKENDS,
  formatCapabilityRecommendation,
  recommendAgentForTask,
  type DispatchBackend,
} from "../orchestrator/capabilities.js";

export type DispatchAgentKind = DispatchBackend;

interface DispatchInput {
  agent: DispatchAgentKind | "auto";
  task: string;
  cwd?: string;
  /** Override the L4 same-cwd conflict guard / lock (default false). */
  force?: boolean;
  /** Set true when running inside an isolated git worktree (bypasses cwd lock). */
  worktree?: boolean;
  /** Set true for read-only / non-mutating runs (bypasses cwd lock). */
  readOnly?: boolean;
  /** Preview capability routing recommendation without launching a process. */
  recommendOnly?: boolean;
}

export interface LaunchAgentOptions {
  log?: (m: string) => void;
  /** Override the same-cwd lock (default false). */
  force?: boolean;
  /** True when the run executes in an isolated git worktree (bypasses cwd lock). */
  worktree?: boolean;
  /** True when the run is read-only / non-mutating (bypasses cwd lock). */
  readOnly?: boolean;
}

/**
 * L4 COORDINATE: is another agent already actively working in this cwd?
 * Checks both live hub sessions and persistent exclusive `cwd-lock` entries on
 * the canonical resolved `realpath` of `cwd`. Returns the conflicting label or null.
 */
export function activeAgentInCwd(cwd: string): string | null {
  const resolved = resolveCwdRealpath(cwd);
  const hub = getCurrentHub();
  if (hub) {
    const clash = hub
      .list()
      .find(
        (s) =>
          s.cwd !== undefined &&
          resolveCwdRealpath(s.cwd) === resolved &&
          (s.state === "working" || s.state === "waiting"),
      );
    if (clash) return `${clash.agent} (${clash.project})`;
  }
  const lock = listActiveCwdLocks().find((l) => l.cwd === resolved);
  if (lock) return `${lock.agent} (pid ${lock.pid})`;
  return null;
}

/** Build the argv for an agent's headless invocation. Pure + tested. */
export function buildDispatchArgv(
  agent: DispatchAgentKind,
  task: string,
  env: Record<string, string | undefined> = process.env,
): { cmd: string; args: string[] } {
  switch (agent) {
    case "claude":
      return { cmd: "claude", args: ["-p", task] };
    case "codex":
      return { cmd: "codex", args: ["exec", task] };
    case "opencode":
      return { cmd: "opencode", args: ["run", task] };
    case "aider":
      return { cmd: "aider", args: ["--message", task, "--yes"] };
    case "copilot":
      return { cmd: "copilot", args: ["-p", task] };
    case "cursor": {
      const override = env.LISA_CURSOR_CMD?.trim();
      return { cmd: override || "agent", args: ["-p", task] };
    }
    case "gemini": {
      const override = env.LISA_GEMINI_CLI_CMD?.trim();
      return { cmd: override || "gemini", args: ["-p", task] };
    }
    default: {
      // exhaustiveness guard
      const _never: never = agent;
      throw new Error(`unknown agent: ${String(_never)}`);
    }
  }
}

/**
 * Resolve the executable for a backend safely (never running a relative binary
 * planted in the project cwd). Exported for tests + availability probes.
 */
export function resolveDispatchBinary(
  agent: DispatchAgentKind,
  env: Record<string, string | undefined> = process.env,
): { ok: true; cmd: string } | { ok: false; cmd: string; error: string } {
  const invocation = buildDispatchArgv(agent, "", env);
  if (agent === "codex" || agent === "claude" || agent === "copilot") {
    const plan = detectPlan(agent);
    if (!plan.binary) {
      return {
        ok: false,
        cmd: invocation.cmd,
        error: `No executable found for ${agent}. Check Coding plans and refresh detection.`,
      };
    }
    return { ok: true, cmd: plan.binary };
  }
  if (agent === "cursor") {
    const override = env.LISA_CURSOR_CMD?.trim();
    if (override) {
      const resolved = findExecutable(override, env);
      if (!resolved) {
        return {
          ok: false,
          cmd: override,
          error: `No executable found for cursor (LISA_CURSOR_CMD="${override}" is not an executable on an absolute path or PATH).`,
        };
      }
      return { ok: true, cmd: resolved };
    }
    const resolved = findExecutable("agent", env) ?? findExecutable("cursor-agent", env);
    if (!resolved) {
      return {
        ok: false,
        cmd: invocation.cmd,
        error:
          'No executable found for cursor (tried "agent" and "cursor-agent" on PATH). Install Cursor CLI or set LISA_CURSOR_CMD.',
      };
    }
    return { ok: true, cmd: resolved };
  }
  if (agent === "gemini") {
    const override = env.LISA_GEMINI_CLI_CMD?.trim();
    if (override) {
      const resolved = findExecutable(override, env);
      if (!resolved) {
        return {
          ok: false,
          cmd: override,
          error: `No executable found for gemini (LISA_GEMINI_CLI_CMD="${override}" is not an executable on an absolute path or PATH).`,
        };
      }
      return { ok: true, cmd: resolved };
    }
    const resolved = findExecutable("gemini", env);
    if (!resolved) {
      return {
        ok: false,
        cmd: invocation.cmd,
        error:
          'No executable found for gemini ("gemini" not found on PATH). Install Gemini CLI or set LISA_GEMINI_CLI_CMD.',
      };
    }
    return { ok: true, cmd: resolved };
  }
  const resolved = findExecutable(invocation.cmd, env);
  if (!resolved) {
    return {
      ok: false,
      cmd: invocation.cmd,
      error: `No executable found for ${agent} ("${invocation.cmd}" not found on PATH).`,
    };
  }
  return { ok: true, cmd: resolved };
}

/** Detect which dispatch backends currently have a resolvable CLI binary. */
export function detectAvailableBackends(
  env: Record<string, string | undefined> = process.env,
): DispatchBackend[] {
  return DISPATCH_BACKENDS.filter((backend) => resolveDispatchBinary(backend, env).ok);
}

export interface LaunchResult {
  pid?: number;
  /** Present when the launch failed (binary missing, spawn error, cwd lock). */
  error?: string;
  cmd: string;
  /** Dispatch ledger id (for dispatch_status / signal_agent), when launched. */
  id?: string;
  /** Captured-output log path, when capture succeeded. */
  logPath?: string;
}

/**
 * Spawn a CLI agent headlessly, detached, and record it in the dispatch ledger.
 * Acquires an exclusive `cwd` lock for non-worktree, mutating runs so concurrent
 * launches cannot clobber the same resolved `realpath` directory.
 * Shared by dispatch_agent (interactive), scheduled_dispatch (heartbeat-timed),
 * and compare_agents (parallel). Never throws — returns {pid} or {error}.
 */
export async function launchAgent(
  agent: DispatchAgentKind,
  task: string,
  cwd: string,
  logOrOpts?: ((m: string) => void) | LaunchAgentOptions,
  extraOpts?: LaunchAgentOptions,
): Promise<LaunchResult> {
  const opts: LaunchAgentOptions =
    typeof logOrOpts === "function"
      ? { ...extraOpts, log: logOrOpts }
      : { ...logOrOpts, ...extraOpts };
  const log = opts.log;
  const invocation = buildDispatchArgv(agent, task);

  let lock: CwdLockInfo | null = null;
  if (!opts.force && !opts.worktree && !opts.readOnly) {
    const lockRes = acquireCwdLock({ cwd, agent });
    if (!lockRes.acquired) {
      return {
        cmd: invocation.cmd,
        error:
          `Refusing to launch ${agent} in ${cwd}: ${lockRes.reason}. ` +
          `Wait for it to finish, pass worktree:true for an isolated worktree, readOnly:true if non-mutating, or force:true to override.`,
      };
    }
    if (!lockRes.bypassed) lock = lockRes.lock;
  }

  const releaseLock = (): void => {
    if (lock) {
      releaseCwdLock(lock);
      lock = null;
    }
  };

  const resolved = resolveDispatchBinary(agent);
  if (!resolved.ok) {
    releaseLock();
    return { cmd: resolved.cmd, error: resolved.error };
  }
  const cmd = resolved.cmd;
  const { args } = invocation;

  // Capture the agent's stdout+stderr so dispatch isn't fire-and-forget: LISA
  // can read back what the agent SHE launched produced (D1 feedback). Detached
  // + a real file fd keeps capturing after LISA's own process exits. Reading a
  // self-dispatched agent's own output is hers to read — distinct from the
  // observers, which deliberately never read another session's content.
  const startedAt = Date.now();
  let logPath: string | undefined;
  let outFd: number | undefined;
  try {
    fs.mkdirSync(dispatchLogDir(), { recursive: true });
    logPath = path.join(
      dispatchLogDir(),
      `${agent}-${startedAt.toString(36)}-${crypto.randomBytes(3).toString("hex")}.log`,
    );
    outFd = fs.openSync(logPath, "a");
  } catch {
    logPath = undefined;
    outFd = undefined;
  }

  let child;
  try {
    child = spawn(cmd, args, {
      cwd,
      env: childEnv(),
      detached: true,
      stdio: outFd !== undefined ? ["ignore", outFd, outFd] : "ignore",
    });
  } catch (err) {
    releaseLock();
    if (outFd !== undefined)
      try {
        fs.closeSync(outFd);
      } catch {
        /* ignore */
      }
    return {
      error: `Failed to launch ${agent}: ${(err as Error).message}. Is "${cmd}" installed and on PATH?`,
      cmd,
    };
  }
  // The child dup'd the fd for its stdio; close our copy.
  if (outFd !== undefined)
    try {
      fs.closeSync(outFd);
    } catch {
      /* ignore */
    }

  // Fingerprint the process NOW, not after the 150 ms race below. child.pid is
  // known the moment spawn() returns, and the token is only obtainable while
  // the process is alive — probing it after the race means a short-lived agent
  // is already reaped and processStartToken() returns null, so the entry falls
  // back to bare-pid identity for the full 24 h retention window. That is
  // exactly the population most at risk: an agent that dies in 150 ms frees its
  // pid immediately, and `signal_agent cancel` on the recycled pid would signal
  // whatever unrelated process group inherited it.
  const startToken = typeof child.pid === "number" ? processStartToken(child.pid) : null;

  // Capture the exit status so dispatch_status can stop claiming a success it
  // never observed. This listener MUST be attached now, before the 150 ms
  // launch race below — an agent that exits inside that window emits "close"
  // before the race resolves, and a listener attached afterwards would never
  // fire. The ledger id doesn't exist yet, so stash the result and let
  // whichever of the two finishes last do the write.
  interface ExitStatus {
    code: number | null;
    signal: NodeJS.Signals | null;
  }
  const pending: { exit: ExitStatus | null } = { exit: null };
  // eslint-disable-next-line prefer-const
  let ledgerId: string | undefined;
  const saveExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (ledgerId === undefined) return;
    try {
      recordExit(ledgerId, code, signal);
    } catch {
      // ledger unwritable — the status just stays unknown
    }
  };
  child.once("close", (code, signal) => {
    pending.exit = { code, signal };
    saveExit(code, signal);
    releaseLock();
  });

  const launchError = await new Promise<string | null>((resolve) => {
    let settled = false;
    child.once("error", (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      resolve(
        e.code === "ENOENT"
          ? `"${cmd}" not found on PATH — is ${agent} installed?`
          : `launch error: ${e.message}`,
      );
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, 150);
  });
  if (launchError) {
    releaseLock();
    if (logPath)
      try {
        fs.unlinkSync(logPath);
      } catch {
        /* ignore */
      }
    return { error: launchError, cmd };
  }

  const pid = child.pid;
  let id: string | undefined;
  if (typeof pid === "number") {
    try {
      id = recordDispatch({ agent, pid, cwd, task, logPath, startToken, now: startedAt }).id;
    } catch (err) {
      log?.(`[dispatch] ledger write failed (non-fatal): ${(err as Error).message}`);
    }
    if (lock && !pending.exit) {
      lock = updateCwdLock(lock, { pid, startToken, dispatchId: id }) ?? lock;
    }
  }

  // The ledger row now exists. If the agent already exited during the launch
  // race, its status is waiting in `pending.exit` — write it through.
  ledgerId = id;
  if (pending.exit) {
    saveExit(pending.exit.code, pending.exit.signal);
    releaseLock();
  }
  child.unref();
  return { pid, cmd, id, logPath };
}

export const dispatchAgentTool: ToolDefinition<DispatchInput, string> = {
  name: "dispatch_agent",
  description:
    "Launch another CLI coding agent (claude, codex, opencode, aider, copilot, cursor, gemini — " +
    "or 'auto' to pick the best backend via capability routing) to work on a task autonomously in a " +
    "given directory. The agent runs in the background and appears in the agent session monitor. " +
    "Enforces an exclusive same-cwd concurrency lock for non-worktree mutating runs (pass worktree:true " +
    "for isolated worktrees or readOnly:true for non-mutating tasks; recommendOnly:true previews routing). " +
    "Returns a handle; it does NOT wait for completion — check dispatch_status or advise_now. " +
    "This spawns an autonomous process, so it requires user approval.",
  inputSchema: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        enum: ["claude", "codex", "opencode", "aider", "copilot", "cursor", "gemini", "auto"],
        description:
          "Which CLI agent to launch, or 'auto' to select the highest-ranked capable backend for the task.",
      },
      task: {
        type: "string",
        description:
          "The task/prompt to give the agent (passed as a single argument, not a shell string).",
        minLength: 1,
      },
      cwd: {
        type: "string",
        description:
          "Absolute working directory the agent should run in. Defaults to the current directory.",
      },
      force: {
        type: "boolean",
        description:
          "Launch even if another agent is already active in this directory (default false — dispatch refuses to avoid clobbering).",
      },
      worktree: {
        type: "boolean",
        description:
          "Set true when this run operates in an isolated git worktree (allows concurrent runs without holding the exclusive cwd lock).",
      },
      readOnly: {
        type: "boolean",
        description:
          "Set true when this task is strictly read-only / non-mutating (allows concurrent runs without holding the exclusive cwd lock).",
      },
      recommendOnly: {
        type: "boolean",
        description:
          "Set true to return the ranked capability-routing recommendation and rationale without launching an agent.",
      },
    },
    required: ["agent", "task"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    let chosenAgent: DispatchAgentKind;
    let routeNote = "";
    if (input.recommendOnly || input.agent === "auto") {
      const hub = getCurrentHub();
      const busyAgents = hub
        ? hub
            .list()
            .filter((s) => s.state === "working" || s.state === "waiting")
            .map((s) => s.agent)
        : [];
      const available = detectAvailableBackends();
      const candidatePool = available.length > 0 ? available : undefined;
      const recommendation = recommendAgentForTask(input.task, candidatePool, { busyAgents });

      if (input.recommendOnly) {
        return formatCapabilityRecommendation(recommendation);
      }
      chosenAgent = recommendation.recommended ?? "claude";
      routeNote = `\nRouting rationale: ${recommendation.rationale}.`;
    } else {
      chosenAgent = input.agent;
    }

    const cwd = input.cwd && input.cwd.startsWith("/") ? input.cwd : ctx.cwd;

    // L4 coordination: don't launch into a directory another agent is already
    // working in unless explicitly forced, worktree-isolated, or read-only.
    if (!input.force && !input.worktree && !input.readOnly) {
      const clash = activeAgentInCwd(cwd);
      if (clash) {
        return (
          `Refusing to launch ${chosenAgent} in ${cwd}: ${clash} is already active there. ` +
          `Running two agents in one directory risks clobbering changes. ` +
          `Wait for it to finish, pick a different directory, pass worktree:true / readOnly:true, or pass force:true to override.`
        );
      }
    }

    const { pid, error, id } = await launchAgent(chosenAgent, input.task, cwd, {
      log: ctx.log,
      force: input.force,
      worktree: input.worktree,
      readOnly: input.readOnly,
    });
    if (error) return error;

    ctx.log(
      `[dispatch] launched ${chosenAgent} (pid ${pid}) in ${cwd}: ${input.task.slice(0, 80)}`,
    );
    return (
      `Launched ${chosenAgent} (pid ${pid}) in ${cwd}.\n` +
      `Running autonomously — I won't block on it. Check whether it finished and read ` +
      `its output with dispatch_status${id ? ` (id ${id})` : ""}; signal_agent lists/cancels it.` +
      routeNote
    );
  },
};
