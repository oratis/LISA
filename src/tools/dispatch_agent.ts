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
import type { ToolDefinition } from "../types.js";
import { getCurrentHub } from "../integrations/current-hub.js";
import { recordDispatch } from "../integrations/dispatch-ledger.js";

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
function activeAgentInCwd(cwd: string): string | null {
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

    const { cmd, args } = buildDispatchArgv(input.agent, input.task);

    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        detached: true, // survive LISA; the agent runs on its own
        stdio: "ignore",
      });
    } catch (err) {
      return `Failed to launch ${input.agent}: ${(err as Error).message}. Is "${cmd}" installed and on PATH?`;
    }

    // If the binary is missing, spawn emits 'error' asynchronously. Surface a
    // useful message in that case rather than silently "succeeding".
    const launchError = await new Promise<string | null>((resolve) => {
      let settled = false;
      child.once("error", (e: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        resolve(
          e.code === "ENOENT"
            ? `"${cmd}" not found on PATH — is ${input.agent} installed?`
            : `launch error: ${e.message}`,
        );
      });
      // Give the spawn a tick to fail fast; if it doesn't, assume it started.
      setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(null);
      }, 150);
    });

    if (launchError) return launchError;

    const pid = child.pid;
    child.unref(); // don't keep LISA's event loop alive for it

    // Record it so signal_agent can list/cancel it from a later turn (the
    // detached child outlives this turn's handle). Never fatal to the dispatch.
    if (typeof pid === "number") {
      try {
        recordDispatch({ agent: input.agent, pid, cwd, task: input.task });
      } catch (err) {
        ctx.log(`[dispatch] ledger write failed (non-fatal): ${(err as Error).message}`);
      }
    }

    ctx.log(`[dispatch] launched ${input.agent} (pid ${pid}) in ${cwd}: ${input.task.slice(0, 80)}`);
    return (
      `Launched ${input.agent} (pid ${pid}) in ${cwd}.\n` +
      `It's running autonomously and will appear in the agent session monitor. ` +
      `I won't block on it — ask me "what's running?" (advise_now) to check progress, ` +
      `or signal_agent to list/cancel it.`
    );
  },
};
