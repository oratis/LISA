/**
 * Integration registry — mirrors src/channels/registry.ts.
 *
 * Each agent adapter calls registerIntegration() at module-load time; the
 * hub looks them up by name. Keeps adapters decoupled and lets community
 * adapters slot in by importing one more module.
 */

import type {
  AgentIntegrationConfig,
  AgentObserver,
  AgentObserverFactory,
} from "./types.js";

const FACTORIES = new Map<string, AgentObserverFactory>();

export function registerIntegration(
  name: string,
  factory: AgentObserverFactory,
): void {
  FACTORIES.set(name, factory);
}

export async function makeIntegration(
  name: string,
  cfg: AgentIntegrationConfig,
): Promise<AgentObserver> {
  const factory = FACTORIES.get(name);
  if (!factory) {
    throw new Error(
      `unknown integration "${name}". Known: ${
        Array.from(FACTORIES.keys()).join(", ") || "(none registered)"
      }`,
    );
  }
  return await factory(cfg);
}

export function listAvailableIntegrations(): string[] {
  return Array.from(FACTORIES.keys()).sort();
}

/** Test hook — clear the registry between unit tests. */
export function _resetIntegrationsForTest(): void {
  FACTORIES.clear();
  builtinsRegistered = false;
}

// Lazy registration of built-in adapters. Each module calls
// registerIntegration() at import time.
let builtinsRegistered = false;
export async function registerBuiltinIntegrations(): Promise<void> {
  if (builtinsRegistered) return;
  builtinsRegistered = true;
  await import("./claude-code/observer.js");
  // Additional adapters register here as they land (codex, opencode, …).
}
