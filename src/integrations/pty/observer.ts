/**
 * PTY-agent observer — surfaces LISA's PTY-backed CLI agents (Stage C spike)
 * in the orchestrator hub, so a real `claude`/`codex` LISA spawned under a
 * pseudo-terminal appears in the roster (island / GUI / menu bar) under its
 * REAL kind ("claude-code"/"codex"), marked controllable so the UI offers
 * send/cancel. Reads the in-process ptyRegistry; emits on its "update" event.
 *
 * The registry is empty unless the spike is enabled (LISA_PTY_AGENTS=1), so at
 * rest this observer contributes nothing.
 *
 * PRIVACY: the roster session is structural only (kind/state/cli) — the captured
 * terminal output is NEVER folded in here; it's served separately, on demand,
 * via /api/agents/pty/<id>/output.
 */
import { EventEmitter } from "node:events";
import { registerIntegration } from "../registry.js";
import { ptyRegistry, type PtyView } from "../../agents/pty.js";
import type { AgentIntegrationConfig, AgentObserver, AgentSession } from "../types.js";

function toSession(v: PtyView): AgentSession {
  return {
    agent: v.agent, // real roster kind: "claude-code" | "codex"
    sessionId: v.id,
    project: v.project,
    cwd: v.cwd,
    state: v.state,
    stateReason: v.stateReason,
    lastMtime: v.lastMtime,
    controllable: "pty",
    ...(v.adoptedSessionId ? { adoptedSessionId: v.adoptedSessionId } : {}),
  };
}

export class PtyObserver extends EventEmitter implements AgentObserver {
  readonly agent = "pty";
  private emitFn: ((s: AgentSession) => void) | null = null;
  private readonly onUpdate = (v: PtyView) => this.emitFn?.(toSession(v));

  async start(emit: (s: AgentSession) => void): Promise<void> {
    this.emitFn = emit;
    ptyRegistry.on("update", this.onUpdate);
  }

  list(): AgentSession[] {
    return ptyRegistry.list().map(toSession);
  }

  async stop(): Promise<void> {
    ptyRegistry.off("update", this.onUpdate);
    this.emitFn = null;
  }
}

registerIntegration("pty", (_cfg: AgentIntegrationConfig) => new PtyObserver());
