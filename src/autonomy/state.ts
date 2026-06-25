/**
 * Autonomy on/off — the "Proactive mode" master switch.
 *
 * When disabled, LISA's unattended self-driven runs (idle reflection and the
 * heartbeat) no-op: she only acts in response to direct user input. The web
 * GUI and the iOS companion surface this as the "Proactive" toggle via
 * GET/POST /api/autonomy/state.
 *
 * Persisted to ~/.lisa/autonomy/state.json (alongside the run ledger
 * runs.jsonl). Default enabled = true, preserving the historical always-on
 * autonomy behavior. Shape + tolerance mirror control/policy.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { LISA_HOME } from "../paths.js";

export interface AutonomyState {
  /** Whether unattended self-driven runs (idle + heartbeat) are allowed. */
  enabled: boolean;
}

export function defaultAutonomyState(): AutonomyState {
  return { enabled: true };
}

/** Coerce an arbitrary object into a valid AutonomyState (default for missing/ill-typed). Pure. */
export function normalizeAutonomyState(s: Partial<AutonomyState> | null | undefined): AutonomyState {
  const base = defaultAutonomyState();
  if (!s || typeof s !== "object") return base;
  return { enabled: typeof s.enabled === "boolean" ? s.enabled : base.enabled };
}

/** Resolved lazily so tests can point LISA_HOME at a tmp dir. */
function statePath(): string {
  return path.join(LISA_HOME, "autonomy", "state.json");
}

/** Read the state, merged over defaults; tolerant of a missing/corrupt file. */
export function loadAutonomyState(): AutonomyState {
  try {
    const raw = fs.readFileSync(statePath(), "utf8");
    return normalizeAutonomyState(JSON.parse(raw) as Partial<AutonomyState>);
  } catch {
    return defaultAutonomyState();
  }
}

export function saveAutonomyState(s: Partial<AutonomyState>): AutonomyState {
  const next = normalizeAutonomyState(s);
  const file = statePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

/** Convenience for the autonomy runners: is unattended self-driving allowed right now? */
export function getAutonomyEnabled(): boolean {
  return loadAutonomyState().enabled;
}

export function setAutonomyEnabled(enabled: boolean): AutonomyState {
  return saveAutonomyState({ enabled });
}
