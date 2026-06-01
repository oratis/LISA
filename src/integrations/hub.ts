/**
 * OrchestratorHub — the one thing the web server talks to for cross-agent
 * session state. Owns every registered AgentObserver, merges their sessions
 * into one normalized list, and re-emits a single "update" event.
 *
 * Replaces the bare single-purpose ClaudeCodeWatcher wiring in server.ts:
 * instead of one watcher, the hub fans out over all enabled integrations.
 */

import { EventEmitter } from "node:events";
import { makeIntegration, registerBuiltinIntegrations } from "./registry.js";
import type {
  AgentIntegrationConfig,
  AgentObserver,
  AgentSession,
  VisibilityTier,
} from "./types.js";

export interface OrchestratorConfig {
  /** Per-integration config, keyed by integration name. */
  integrations: Record<string, AgentIntegrationConfig>;
  /** Global visibility tier; integrations may override per-entry. */
  visibility: VisibilityTier;
}

/** Default config when ~/.lisa/agents.json is absent: just Claude Code, at
 *  the "activity" tier (Tier 2 — structural, no conversation content). */
export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  integrations: {
    "claude-code": { enabled: true },
    // Available but off by default — enable in ~/.lisa/agents.json once you
    // use Codex. Graceful no-op if ~/.codex/sessions is absent anyway.
    codex: { enabled: false },
    // Cloud agent: watches your open GitHub PRs (checks / review / merge) via
    // the `gh` CLI. Off by default; opt in, optionally with
    // `{ "enabled": true, "repos": ["owner/repo"] }`. No-op if `gh` is absent.
    "github-pr": { enabled: false },
  },
  visibility: "activity",
};

type Log = (msg: string) => void;

export class OrchestratorHub extends EventEmitter {
  private observers: AgentObserver[] = [];
  private readonly cfg: OrchestratorConfig;
  private readonly log: Log;
  private started = false;

  private readonly registerBuiltins: boolean;

  constructor(cfg: OrchestratorConfig, opts: { log?: Log; registerBuiltins?: boolean } = {}) {
    super();
    this.cfg = cfg;
    this.log = opts.log ?? (() => {});
    // Tests pre-register fake observers and set this false so start() doesn't
    // pull in (and clobber with) the real builtin adapters.
    this.registerBuiltins = opts.registerBuiltins ?? true;
    this.setMaxListeners(64);
  }

  /** Instantiate + start every enabled integration. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (this.registerBuiltins) await registerBuiltinIntegrations();

    for (const [name, entry] of Object.entries(this.cfg.integrations)) {
      if (entry.enabled === false) continue;
      // Resolve the effective visibility for this integration.
      const visibility = entry.visibility ?? this.cfg.visibility;
      try {
        const obs = await makeIntegration(name, { ...entry, visibility });
        await obs.start((session) => {
          this.emit("update", session);
        });
        this.observers.push(obs);
        this.log(`[orchestrator] integration "${name}" started (visibility=${visibility})`);
      } catch (err) {
        // A bad/unknown integration must not take down the others.
        this.log(`[orchestrator] integration "${name}" failed: ${(err as Error).message}`);
      }
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    await Promise.all(this.observers.map((o) => o.stop().catch(() => {})));
    this.observers = [];
  }

  /**
   * Merged snapshot across all observers. Sorted by recency (newest first)
   * so the UI + advisor see a single ranked stream.
   */
  list(): AgentSession[] {
    const all: AgentSession[] = [];
    for (const o of this.observers) {
      try {
        all.push(...o.list());
      } catch {
        // one flaky observer shouldn't break the merge
      }
    }
    return all.sort((a, b) => b.lastMtime - a.lastMtime);
  }

  /** Sessions for one agent kind. */
  listByAgent(agent: string): AgentSession[] {
    return this.list().filter((s) => s.agent === agent);
  }
}

/** Load ~/.lisa/agents.json, falling back to the default config. */
export async function loadOrchestratorConfig(
  path: string,
): Promise<OrchestratorConfig> {
  const fs = await import("node:fs/promises");
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch {
    return DEFAULT_ORCHESTRATOR_CONFIG;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<OrchestratorConfig>;
    return {
      integrations: parsed.integrations ?? DEFAULT_ORCHESTRATOR_CONFIG.integrations,
      visibility: parsed.visibility ?? DEFAULT_ORCHESTRATOR_CONFIG.visibility,
    };
  } catch {
    return DEFAULT_ORCHESTRATOR_CONFIG;
  }
}
