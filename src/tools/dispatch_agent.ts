/**
 * dispatch_agent (L3 DISPATCH) — LISA launches another CLI agent with a task
 * and tracks it, turning observation into orchestration.
 *
 * Each supported agent has a non-interactive ("headless") invocation:
 *   claude    → claude -p "<task>"
 *   codex     → codex exec "<task>"
 *   opencode  → opencode run "<task>"
 *   aider     → aider --message "<task>" --yes
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

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ToolDefinition } from "../types.js";
import { getCurrentHub } from "../integrations/current-hub.js";
import { recordDispatch, dispatchLogDir } from "../integrations/dispatch-ledger.js";

interface DispatchInput {
  agent: "claude" | "codex" | "opencode" | "aider";
  task: string;
  cwd?: string;
  /** Override the L4 same-cwd conflict guard (default false). */
  force?: boolean;
}

/**
 * L4 COORDINATE: is another agent already actively working in this cwd?
 * Launching a second agent into the same directory is the #1 way multi-agent
 * setups clobber a repo, so dispatch refuses by default (overridable with
 * force). Returns the conflicting session's label, or null if clear.
 */
export function activeAgentInCwd(cwd: string): string | null {
  const hub = getCurrentHub();
  if (!hub) return null; // no monitor → can't check; allow
  const clash = hub
    .list()
    .find(
      (s) =>
        s.cwd === cwd && (s.state === "working" || s.state === "waiting"),
    );
  return clash ? `${clash.agent} (${clash.project})` : null;
}

/** Build the argv for an agent's headless invocation. Pure + tested. */
export function buildDispatchArgv(
  agent: DispatchInput["agent"],
  task: string,
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
    default: {
      // exhaustiveness guard
      const _never: never = agent;
      throw new Error(`unknown agent: ${String(_never)}`);
    }
  }
}

export type DispatchAgentKind = DispatchInput["agent"];

export interface LaunchResult {
  pid?: number;
  /** Present when the launch failed (binary missing, spawn error). */
  error?: string;
  cmd: string;
  /** Dispatch ledger id (for dispatch_status / signal_agent), when launched. */
  id?: string;
  /** Captured-output log path, when capture succeeded. */
  logPath?: string;
}

/**
 * Spawn a CLI agent headlessly, detached, and record it in the dispatch ledger.
 * Shared by dispatch_agent (interactive), scheduled_dispatch (heartbeat-timed),
 * and compare_agents (parallel). Never throws — returns {pid} or {error}.
 */
export async function launchAgent(
  agent: DispatchAgentKind,
  task: string,
  cwd: string,
  log?: (m: string) => void,
): Promise<LaunchResult> {
  const { cmd, args } = buildDispatchArgv(agent, task);

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
      detached: true,
      stdio: outFd !== undefined ? ["ignore", outFd, outFd] : "ignore",
    });
  } catch (err) {
    if (outFd !== undefined) try { fs.closeSync(outFd); } catch { /* ignore */ }
    return { error: `Failed to launch ${agent}: ${(err as Error).message}. Is "${cmd}" installed and on PATH?`, cmd };
  }
  // The child dup'd the fd for its stdio; close our copy.
  if (outFd !== undefined) try { fs.closeSync(outFd); } catch { /* ignore */ }

  const launchError = await new Promise<string | null>((resolve) => {
    let settled = false;
    child.once("error", (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      resolve(e.code === "ENOENT" ? `"${cmd}" not found on PATH — is ${agent} installed?` : `launch error: ${e.message}`);
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, 150);
  });
  if (launchError) {
    if (logPath) try { fs.unlinkSync(logPath); } catch { /* ignore */ }
    return { error: launchError, cmd };
  }

  const pid = child.pid;
  child.unref();
  let id: string | undefined;
  if (typeof pid === "number") {
    try {
      id = recordDispatch({ agent, pid, cwd, task, logPath, now: startedAt }).id;
    } catch (err) {
      log?.(`[dispatch] ledger write failed (non-fatal): ${(err as Error).message}`);
    }
  }
  return { pid, cmd, id, logPath };
}

export const dispatchAgentTool: ToolDefinition<DispatchInput, string> = {
  name: "dispatch_agent",
  description:
    "Launch another CLI coding agent (claude, codex, opencode, aider) to work on a task " +
    "autonomously in a given directory. The agent runs in the background and appears in " +
    "the agent session monitor. Use when the user asks you to hand work to another agent, " +
    "or to pursue a desire by dispatching one. Returns a handle; it does NOT wait for the " +
    "agent to finish — check the session monitor or use advise_now for progress. " +
    "This spawns an autonomous process, so it requires user approval.",
  inputSchema: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        enum: ["claude", "codex", "opencode", "aider"],
        description: "Which CLI agent to launch.",
      },
      task: {
        type: "string",
        description: "The task/prompt to give the agent (passed as a single argument, not a shell string).",
        minLength: 1,
      },
      cwd: {
        type: "string",
        description: "Absolute working directory the agent should run in. Defaults to the current directory.",
      },
      force: {
        type: "boolean",
        description: "Launch even if another agent is already active in this directory (default false — dispatch refuses to avoid clobbering).",
      },
    },
    required: ["agent", "task"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const cwd = input.cwd && input.cwd.startsWith("/") ? input.cwd : ctx.cwd;

    // L4 coordination: don't launch into a directory another agent is already
    // working in unless explicitly forced.
    if (!input.force) {
      const clash = activeAgentInCwd(cwd);
      if (clash) {
        return (
          `Refusing to launch ${input.agent} in ${cwd}: ${clash} is already active there. ` +
          `Running two agents in one directory risks clobbering changes. ` +
          `Wait for it to finish, pick a different directory, or pass force:true to override.`
        );
      }
    }

    const { pid, error, id } = await launchAgent(input.agent, input.task, cwd, ctx.log);
    if (error) return error;

    ctx.log(`[dispatch] launched ${input.agent} (pid ${pid}) in ${cwd}: ${input.task.slice(0, 80)}`);
    return (
      `Launched ${input.agent} (pid ${pid}) in ${cwd}.\n` +
      `Running autonomously — I won't block on it. Check whether it finished and read ` +
      `its output with dispatch_status${id ? ` (id ${id})` : ""}; signal_agent lists/cancels it.`
    );
  },
};
