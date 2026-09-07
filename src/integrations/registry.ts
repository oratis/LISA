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

/**
 * The built-in factories as first captured, so a reset is actually undoable.
 *
 * The imports below only register on their FIRST evaluation: ESM caches
 * modules, so once `./git/observer.js` has been imported its top-level
 * registerIntegration("git", …) never runs again. That made
 * _resetIntegrationsForTest() a one-way door — it emptied the registry for the
 * rest of the process, and the next makeIntegration("claude-code") threw
 * `unknown integration`. Within one test file that was invisible only because
 * the reset happened to run last; appending a test after it, or importing the
 * hub tests alongside another suite, surfaced it.
 */
let builtinSnapshot: Map<string, AgentObserverFactory> | null = null;

export async function registerBuiltinIntegrations(): Promise<void> {
  if (builtinsRegistered) return;
  builtinsRegistered = true;
  if (builtinSnapshot) {
    for (const [name, factory] of builtinSnapshot) FACTORIES.set(name, factory);
    return;
  }
  const before = new Set(FACTORIES.keys());
  await import("./claude-code/observer.js");
  await import("./codex/observer.js");
  await import("./github-pr/observer.js");
  await import("./opencode/observer.js");
  await import("./aider/observer.js");
  await import("./git/observer.js");
  await import("./shell/observer.js");
  await import("./takoapi/observer.js");
  await import("./managed/observer.js");
  await import("./pty/observer.js");
  const snapshot = new Map<string, AgentObserverFactory>();
  for (const [name, factory] of FACTORIES) {
    if (!before.has(name)) snapshot.set(name, factory);
  }
  builtinSnapshot = snapshot;
}
