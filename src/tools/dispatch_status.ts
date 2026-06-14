/**
 * dispatch_status (L3 DISPATCH — feedback half of the command loop, D1).
 *
 * dispatch_agent launches agents detached and fire-and-forget; this closes the
 * loop on the READ side: for each agent LISA dispatched, report whether it's
 * still running or has finished, and show the tail of its captured output — so
 * Lisa (and the user) can actually see what the delegated agent produced.
 *
 * This reads the output of an agent LISA HERSELF launched (captured to a log by
 * dispatch_agent). That's hers to read — distinct from the observers, which
 * deliberately never read another session's content. It's read-only: no spawn,
 * no signal. (Mid-run approval-relay / steering is a separate, harder piece —
 * it needs a control surface each headless CLI doesn't currently expose.)
 */
import type { ToolDefinition } from "../types.js";
import {
  isAlive,
  listRecentDispatches,
  readDispatchOutput,
  type DispatchEntry,
} from "../integrations/dispatch-ledger.js";

interface DispatchStatusInput {
  /** A dispatch id or pid; omit to list all recent dispatches. */
  id?: string;
}

function fmtAge(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `    | ${l}`)
    .join("\n");
}

function render(e: DispatchEntry, now: number, maxBytes: number): string {
  const live = isAlive(e.pid);
  const age = Math.max(0, Math.round((now - e.startedAt) / 1000));
  const head =
    `${live ? "▶ running" : "✓ finished"} · ${e.agent} (pid ${e.pid}, ${fmtAge(age)} ago) · id ${e.id}\n` +
    `  task: ${e.task.slice(0, 100)}`;
  const out = readDispatchOutput(e, maxBytes).trim();
  if (!out) return `${head}\n  (no output captured${e.logPath ? " yet" : ""})`;
  return `${head}\n  output (tail):\n${indent(out)}`;
}

export const dispatchStatusTool: ToolDefinition<DispatchStatusInput, string> = {
  name: "dispatch_status",
  description:
    "Check on the CLI agents you dispatched (dispatch_agent): whether each is still running or has " +
    "finished, and the tail of its captured output — so dispatching isn't fire-and-forget. Pass `id` " +
    "(a dispatch id or pid) for one agent's fuller output, or omit to list all recent dispatches. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "A dispatch id (from dispatch_agent) or pid; omit to list all recent dispatches.",
      },
    },
    additionalProperties: false,
  },
  async execute(input) {
    const all = listRecentDispatches();
    const now = Date.now();
    if (input.id) {
      const e = all.find((x) => x.id === input.id || String(x.pid) === input.id);
      if (!e) return `No dispatch found for "${input.id}". (It may have aged out, or was never dispatched by me.)`;
      return render(e, now, 4000);
    }
    if (all.length === 0) return "No dispatched agents on record.";
    return all
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((e) => render(e, now, 600))
      .join("\n\n");
  },
};
