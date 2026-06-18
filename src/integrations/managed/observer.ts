/**
 * Managed-agent observer — surfaces LISA's own managed agents in the
 * orchestrator hub alongside observed CLIs, so they appear in the roster
 * (island / GUI / menu bar) with live progress and a pendingPermission flag.
 * Reads the in-process managedRegistry; emits on its "update" event.
 */
import { EventEmitter } from "node:events";
import { registerIntegration } from "../registry.js";
import { managedRegistry, type ManagedView } from "../../agents/managed.js";
import type { AgentIntegrationConfig, AgentObserver, AgentSession } from "../types.js";

function toSession(v: ManagedView): AgentSession {
  return {
    agent: "managed",
    sessionId: v.id,
    project: v.project,
    cwd: v.cwd,
    state: v.state,
    stateReason: v.stateReason,
    lastMtime: v.lastMtime,
    activity: {
      turnCount: v.turnCount,
      lastTools: v.lastTools,
      filesTouched: v.filesTouched,
      tokens: v.tokens,
      ...(v.pending ? { pendingPermission: v.pending.tool } : {}),
    },
  };
}

export class ManagedObserver extends EventEmitter implements AgentObserver {
  readonly agent = "managed";
  private emitFn: ((s: AgentSession) => void) | null = null;
  private readonly onUpdate = (v: ManagedView) => this.emitFn?.(toSession(v));

  async start(emit: (s: AgentSession) => void): Promise<void> {
    this.emitFn = emit;
    managedRegistry.on("update", this.onUpdate);
  }

  list(): AgentSession[] {
    return managedRegistry.list().map(toSession);
  }

  async stop(): Promise<void> {
    managedRegistry.off("update", this.onUpdate);
    this.emitFn = null;
  }
}

registerIntegration("managed", (_cfg: AgentIntegrationConfig) => new ManagedObserver());
