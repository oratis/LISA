/**
 * TakoAPI observer (Dispatch D2b) — surfaces the REMOTE agents LISA has called
 * (or the user pinned) as first-class sessions in the orchestrator hub, with
 * their last A2A TaskState, alongside local agents.
 *
 * Source of truth is the call ledger (takoapi-calls.json), written by the
 * `takoapi` tool when LISA delegates a task. The observer NEVER lists the
 * registry — discovery is the tool's job (`takoapi discover`); monitoring shows
 * only agents you've interacted with (called) plus a small explicit pin list:
 *   ~/.lisa/agents.json → { "takoapi": { "enabled": true, "pin": ["slug-a"] } }
 *
 * Off by default. With no calls and no pins it lists nothing (effective no-op).
 * PRIVACY: structural only — slug, TaskState, timestamps; no prompts/replies.
 */
import { EventEmitter } from "node:events";
import { registerIntegration } from "../registry.js";
import type {
  AgentIntegrationConfig,
  AgentObserver,
  AgentSession,
} from "../types.js";
import { taskStateToSessionState } from "./a2a.js";
import { listTakoCalls, takoLedgerEvents, type TakoCallEntry } from "./ledger.js";

/** Remote delegations linger longer than chat sessions but shouldn't pile up. */
const ACTIVE_WINDOW_MS = 3 * 60 * 60_000; // 3h
const MAX_LISTED = 10;

/** Read the `pin` list off the integration config, ignoring junk. */
export function pinsOf(cfg: AgentIntegrationConfig): string[] {
  const raw = (cfg as Record<string, unknown>).pin;
  return Array.isArray(raw)
    ? raw.filter((s): s is string => typeof s === "string")
    : [];
}

/**
 * Build the hub session list from ledger entries + pinned slugs. Pure given its
 * inputs (the unit under test):
 *   - called agents within the active window → their mapped TaskState
 *   - pinned slugs with no recent call       → idle ("pinned"), kept visible
 * One row per slug (a called pin uses its real call state, not "pinned").
 */
export function buildTakoSessions(
  calls: TakoCallEntry[],
  pins: string[],
  now: number,
): AgentSession[] {
  const cutoff = now - ACTIVE_WINDOW_MS;
  const bySlug = new Map<string, AgentSession>();
  for (const c of calls) {
    if (c.lastMtime < cutoff) continue;
    const { state, reason } = taskStateToSessionState(c.lastState);
    bySlug.set(c.slug, {
      agent: "takoapi",
      sessionId: c.slug,
      project: c.slug,
      state,
      stateReason: reason,
      lastMtime: c.lastMtime,
    });
  }
  // Pins the user wants always visible, even when idle. A pin that WAS called
  // recently keeps its real state (set above); only never-/stale-called pins
  // are added as idle, stamped `now` so the frontend's window keeps them.
  for (const slug of pins) {
    if (!bySlug.has(slug)) {
      bySlug.set(slug, {
        agent: "takoapi",
        sessionId: slug,
        project: slug,
        state: "idle",
        stateReason: "pinned",
        lastMtime: now,
      });
    }
  }
  return [...bySlug.values()]
    .sort((a, b) => b.lastMtime - a.lastMtime)
    .slice(0, MAX_LISTED);
}

export class TakoApiObserver extends EventEmitter implements AgentObserver {
  readonly agent = "takoapi";
  private pins: string[];
  private emitFn: ((s: AgentSession) => void) | null = null;
  private readonly onChange = () => this.flush();

  constructor(cfg: AgentIntegrationConfig) {
    super();
    this.pins = pinsOf(cfg);
  }

  async start(emit: (s: AgentSession) => void): Promise<void> {
    this.emitFn = emit;
    // The tool records calls in this same process; re-emit on each ledger change
    // so a fresh delegation shows up live (not just on the next snapshot fetch).
    takoLedgerEvents.on("change", this.onChange);
    this.flush(); // surface any past calls / pins immediately
  }

  list(): AgentSession[] {
    return buildTakoSessions(listTakoCalls(), this.pins, Date.now());
  }

  async stop(): Promise<void> {
    takoLedgerEvents.off("change", this.onChange);
    this.emitFn = null;
  }

  private flush(): void {
    if (!this.emitFn) return;
    for (const s of this.list()) this.emitFn(s);
  }
}

registerIntegration("takoapi", (cfg) => new TakoApiObserver(cfg));
