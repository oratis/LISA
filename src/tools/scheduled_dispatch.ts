/**
 * scheduled_dispatch (vibe-coding) — schedule an agent to run a task on a
 * recurring basis: "every night triage the issue backlog", "every 2h sync the
 * docs". Entries are stored and fired by the heartbeat at its cadence.
 *
 * SAFETY: this auto-launches an autonomous agent unattended (no approval at
 * fire time, like any heartbeat action). Each entry has a maxRuns cap (default
 * 30) so a forgotten schedule can't run forever. Needs the heartbeat installed
 * (`lisa heartbeat install`) to actually fire.
 */
import type { ToolDefinition } from "../types.js";
import {
  loadScheduled,
  addScheduled,
  removeScheduled,
  isValidSchedule,
  describeScheduled,
  DEFAULT_MAX_RUNS,
  type ScheduledAgent,
} from "../integrations/scheduled-dispatch.js";

interface ScheduledDispatchInput {
  action: "add" | "list" | "remove";
  agent?: ScheduledAgent;
  task?: string;
  cwd?: string;
  /** "every:30m" | "every:2h" | "every:1d" | "daily:09:00" */
  schedule?: string;
  /** Max times to fire before going inert. Default 30. */
  max_runs?: number;
  /** For remove: the entry id (or prefix). */
  id?: string;
}

export const scheduledDispatchTool: ToolDefinition<ScheduledDispatchInput, string> = {
  name: "scheduled_dispatch",
  description:
    "Schedule a CLI agent to run a task recurringly (fired by the heartbeat). action:'add' needs " +
    "agent + task + cwd + schedule ('every:30m'/'every:2h'/'every:1d'/'daily:09:00'); 'list' shows " +
    "scheduled dispatches; 'remove' (needs id) deletes one. Use for standing autonomous work like " +
    "nightly issue triage or periodic doc sync. It auto-launches an agent unattended, so it has a " +
    "maxRuns cap (default 30) and needs `lisa heartbeat install` to fire.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add", "list", "remove"] },
      agent: { type: "string", enum: ["claude", "codex", "opencode", "aider"], description: "Which agent to launch (for add)." },
      task: { type: "string", description: "Task/prompt for the agent (for add).", minLength: 1 },
      cwd: { type: "string", description: "Absolute working directory (for add). Defaults to the current directory." },
      schedule: { type: "string", description: "every:30m | every:2h | every:1d | daily:HH:MM (for add)." },
      max_runs: { type: "integer", minimum: 1, maximum: 1000, description: `Max fires before inert (default ${DEFAULT_MAX_RUNS}).` },
      id: { type: "string", description: "Entry id or prefix (for remove)." },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    if (input.action === "list") {
      const entries = await loadScheduled();
      if (entries.length === 0) return "(no scheduled dispatches)";
      return `${entries.length} scheduled dispatch(es):\n` + entries.map(describeScheduled).join("\n");
    }

    if (input.action === "remove") {
      if (!input.id) return "(remove needs an id — from scheduled_dispatch action:'list')";
      const ok = await removeScheduled(input.id);
      return ok ? `Removed scheduled dispatch ${input.id}.` : `(no scheduled dispatch matches "${input.id}")`;
    }

    // add
    if (!input.agent || !input.task || !input.schedule) {
      return "(add needs agent, task and schedule)";
    }
    if (!isValidSchedule(input.schedule)) {
      return `(bad schedule "${input.schedule}" — use every:30m / every:2h / every:1d / daily:09:00)`;
    }
    const cwd = input.cwd && input.cwd.startsWith("/") ? input.cwd : ctx.cwd;
    const entry = await addScheduled({
      agent: input.agent,
      task: input.task,
      cwd,
      schedule: input.schedule,
      maxRuns: input.max_runs ?? DEFAULT_MAX_RUNS,
    });
    const heartbeatNote =
      "\n(Fires via the heartbeat — if you haven't, run `lisa heartbeat install` so it actually ticks.)";
    return (
      `Scheduled ${entry.agent} ${entry.schedule} in ${cwd} (id ${entry.id}, max ${entry.maxRuns} runs):\n` +
      `  "${input.task.slice(0, 100)}"` +
      heartbeatNote
    );
  },
};
