/**
 * Process-wide handle to the live OrchestratorHub.
 *
 * The hub's session state lives in memory in the web-server process. The
 * advise_now tool (which runs in that same process during a chat turn) and
 * the server's periodic advisor tick both need it, so we expose it as a
 * tiny singleton the server sets at startup. Null until the server starts
 * (e.g. CLI-only runs) — callers must handle that.
 */

import type { OrchestratorHub } from "./hub.js";

let current: OrchestratorHub | null = null;

export function setCurrentHub(hub: OrchestratorHub | null): void {
  current = hub;
}

export function getCurrentHub(): OrchestratorHub | null {
  return current;
}
