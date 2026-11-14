import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWrite } from "../../fs-utils.js";
import { withFileLock } from "../../soul/lock.js";
import type { OrchestratorHub } from "../hub.js";
import type { AgentIntegrationConfig } from "../types.js";

export function codexSessionsRoot(home?: string): string {
  const base = home
    ? home.replace(/^~/, os.homedir())
    : (process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
  return path.join(base, "sessions");
}

export async function codexObservationStatus(
  hub: OrchestratorHub,
  home: string | undefined,
  showsActivity: boolean,
) {
  const detected = await fs.stat(codexSessionsRoot(home)).then(
    (s) => s.isDirectory(),
    () => false,
  );
  return { enabled: hub.hasObserver("codex"), detected, showsActivity };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Preserve hand-edited options and every other integration. A malformed file
// must be repaired by its owner, never silently replaced with defaults.
export async function setCodexObservation(
  file: string,
  hub: OrchestratorHub,
  enabled: boolean,
  showConversations: boolean,
) {
  return withFileLock(file + ".lock", async () => {
    let config: unknown;
    try {
      config = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      config = {};
    }
    if (!isObject(config)) throw new Error("Invalid agents.json");
    const integrations = config.integrations === undefined ? {} : config.integrations;
    if (!isObject(integrations)) throw new Error("Invalid integrations in agents.json");
    const previous = integrations.codex === undefined ? {} : integrations.codex;
    if (!isObject(previous)) throw new Error("Invalid Codex configuration");
    const entry: AgentIntegrationConfig = { ...previous, enabled };
    if (showConversations && previous.visibility !== "intent") entry.visibility = "activity";
    const wasEnabled = hub.hasObserver("codex");
    const reconfigure =
      wasEnabled && enabled && showConversations && previous.visibility !== entry.visibility;
    if (reconfigure) await hub.setObserverEnabled("codex", { enabled: false });
    try {
      await hub.setObserverEnabled("codex", entry);
      const updated = { ...config, integrations: { ...integrations, codex: entry } };
      await atomicWrite(file, JSON.stringify(updated, null, 2) + "\n", 0o600);
    } catch (err) {
      if (reconfigure) await hub.setObserverEnabled("codex", { enabled: false });
      await hub.setObserverEnabled("codex", { ...previous, enabled: wasEnabled });
      throw err;
    }
    return entry;
  });
}
