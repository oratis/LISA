/**
 * signal_agent (L3/O5 DISPATCH — active control) — the other half of
 * dispatch_agent. Once LISA has launched CLI agents she should be able to act
 * on what she observes: see which of her dispatched agents are still running
 * and stop one that's stuck, conflicting, or burning tokens.
 *
 * Scope & safety:
 *   - It only ever targets agents recorded in the dispatch ledger — i.e. ones
 *     LISA *herself* launched via dispatch_agent. The user's own manually
 *     started sessions are observed via session files, carry no pid, and are
 *     therefore unreachable here. LISA cannot kill an arbitrary process.
 *   - `cancel` terminates an autonomous process the host already approved
 *     LISA to spawn; it's the inverse of that approval. It sends SIGTERM to the
 *     whole process *group* (dispatch spawns detached group leaders, so the
 *     agent's child processes die with it), then escalates to SIGKILL after a
 *     short grace period if the group is still alive.
 *
 * Composes with the advisor: "codex looks stuck in ~/p — cancel it?" →
 * signal_agent({action:"cancel", target:"<id>"}).
 */

import type { ToolDefinition } from "../types.js";
import {
  findDispatch,
  listLiveDispatches,
  removeDispatch,
  isAlive,
  type DispatchEntry,
} from "../integrations/dispatch-ledger.js";

interface SignalInput {
  action: "list" | "cancel";
  /** For cancel: the dispatch id (preferred) or pid of the agent to stop. */
  target?: string;
  /** Skip the graceful SIGTERM and SIGKILL the group immediately. */
  force?: boolean;
}

/** Human-friendly elapsed time, e.g. "3m", "2h 5m", "8s". */
export function formatUptime(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** One ledger entry → a readable line. Pure, for display + tests. */
export function formatDispatchLine(e: DispatchEntry, now: number): string {
  const up = formatUptime(now - e.startedAt);
  const task = e.task.length > 70 ? e.task.slice(0, 67) + "…" : e.task;
  return `• ${e.id}  ${e.agent} (pid ${e.pid}, up ${up})  ${e.cwd}\n    "${task}"`;
}

/**
 * Send `signal` to the process group led by `pid`, falling back to the lone
 * process if the group send fails. Returns true if either delivery succeeded.
 */
function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal); // negative pid → whole process group
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false; // already gone, or not permitted
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const signalAgentTool: ToolDefinition<SignalInput, string> = {
  name: "signal_agent",
  description:
    "List or stop the CLI agents LISA dispatched. action:'list' shows the still-running " +
    "agents LISA launched via dispatch_agent (id, agent, pid, uptime, cwd, task). " +
    "action:'cancel' (needs target = the id or pid from the list) stops one: SIGTERM to " +
    "its process group, escalating to SIGKILL after a grace period (or pass force:true to " +
    "kill immediately). Use when a dispatched agent is stuck, conflicting, or running away. " +
    "Only agents LISA herself dispatched can be targeted — never the user's own sessions.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "cancel"],
        description: "'list' the running dispatched agents, or 'cancel' one.",
      },
      target: {
        type: "string",
        description:
          "For cancel: the dispatch id (preferred) or the pid of the agent to stop. From action:'list'.",
      },
      force: {
        type: "boolean",
        description:
          "Cancel only: skip graceful SIGTERM and SIGKILL the process group immediately (default false).",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const now = Date.now();

    if (input.action === "list") {
      const live = listLiveDispatches();
      if (live.length === 0) {
        return "No agents dispatched by LISA are currently running. (Only agents launched via dispatch_agent are tracked here.)";
      }
      const lines = live
        .sort((a, b) => a.startedAt - b.startedAt)
        .map((e) => formatDispatchLine(e, now))
        .join("\n");
      return `${live.length} dispatched agent${live.length === 1 ? "" : "s"} running:\n${lines}\n\nCancel one with signal_agent({action:"cancel", target:"<id>"}).`;
    }

    // action === "cancel"
    const target = (input.target ?? "").trim();
    if (!target) {
      return 'cancel needs a target — the dispatch id or pid from signal_agent({action:"list"}).';
    }

    const entry = findDispatch(target);
    if (!entry) {
      const live = listLiveDispatches();
      const hint =
        live.length > 0
          ? ` Currently running: ${live.map((e) => `${e.id} (${e.agent}, pid ${e.pid})`).join(", ")}.`
          : " No dispatched agents are running.";
      return `No running dispatched agent matches "${target}".${hint}`;
    }

    const sig: NodeJS.Signals = input.force ? "SIGKILL" : "SIGTERM";
    const delivered = signalGroup(entry.pid, sig);
    if (!delivered && !isAlive(entry.pid)) {
      // It exited on its own between the lookup and the signal — clean up.
      removeDispatch(entry.id);
      return `${entry.agent} (pid ${entry.pid}) had already exited; removed it from the ledger.`;
    }

    let escalated = false;
    if (!input.force) {
      // Give it a moment to shut down gracefully, then SIGKILL if it clings on.
      await sleep(1500);
      if (isAlive(entry.pid)) {
        escalated = signalGroup(entry.pid, "SIGKILL");
      }
    }

    removeDispatch(entry.id);
    ctx.log(
      `[signal] cancelled ${entry.agent} (pid ${entry.pid}) in ${entry.cwd}${escalated ? " [SIGKILL]" : ""}`,
    );

    const how = input.force
      ? "SIGKILL"
      : escalated
        ? "SIGTERM then SIGKILL"
        : "SIGTERM";
    return `Cancelled ${entry.agent} (pid ${entry.pid}) in ${entry.cwd} via ${how}. Removed from the dispatch ledger.`;
  },
};
