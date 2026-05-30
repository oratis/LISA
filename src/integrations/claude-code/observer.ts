/**
 * Claude Code AgentObserver — adapts the existing ClaudeCodeWatcher to the
 * normalized cross-agent interface and registers it in the integration
 * registry.
 *
 * The watcher itself is unchanged (it's well-tested); this is a thin
 * normalization layer: ClaudeSessionInfo → AgentSession. Activity (Tier 2)
 * is attached when the watcher provides it.
 */

import { ClaudeCodeWatcher, type ClaudeSessionInfo } from "./watcher.js";
import { registerIntegration } from "../registry.js";
import type {
  AgentIntegrationConfig,
  AgentObserver,
  AgentSession,
} from "../types.js";

function toAgentSession(info: ClaudeSessionInfo): AgentSession {
  return {
    agent: "claude-code",
    sessionId: info.sessionId,
    project: info.projectLabel,
    cwd: info.cwd,
    state: info.state,
    stateReason: info.stateReason,
    lastMtime: info.lastMtime,
    activity: info.activity,
  };
}

export class ClaudeCodeObserver implements AgentObserver {
  readonly agent = "claude-code";
  private watcher: ClaudeCodeWatcher;

  constructor(_cfg: AgentIntegrationConfig) {
    this.watcher = new ClaudeCodeWatcher({
      log: (m) => console.error(m),
    });
  }

  async start(emit: (s: AgentSession) => void): Promise<void> {
    // The watcher's "update" payload is a lightweight ClaudeSessionUpdate
    // (no lastMtime/activity), so we re-derive the full session from the
    // current snapshot by sessionId. listActive() includes the just-updated
    // session (its mtime is current), so the lookup succeeds.
    this.watcher.on("update", (payload: { sessionId: string }) => {
      const info = this.watcher
        .listActive()
        .find((s) => s.sessionId === payload.sessionId);
      if (info) emit(toAgentSession(info));
    });
    await this.watcher.start();
  }

  list(): AgentSession[] {
    return this.watcher.listActive().map(toAgentSession);
  }

  async stop(): Promise<void> {
    this.watcher.stop();
  }
}

registerIntegration("claude-code", (cfg) => new ClaudeCodeObserver(cfg));
