/**
 * Remote-control policy — the Mac-side opt-in that gates high-risk control
 * actions when they come from a REMOTE (non-loopback) caller, e.g. the phone.
 *
 * The auth gate (token) already proves "a trusted device"; this adds a second
 * axis: *which* actions a trusted remote device may take. The local user
 * (loopback) is never gated. Defaults:
 *   - remoteControl: true  — a remote may control LISA's OWN agents (managed/pty:
 *       start / send / cancel / approve). These are LISA-owned and lower-risk.
 *   - remoteAdoptExternal: false — adopting the user's EXTERNAL sessions
 *       (`claude --resume` of an idle session) touches a real transcript, so a
 *       remote device may not do it until the Mac owner explicitly opts in.
 *
 * Persisted to ~/.lisa/control-policy.json; changeable only from localhost
 * (POST /api/control/policy is loopback-only), like the API-key save.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ControlPolicy {
  /** Remote callers may control LISA's own agents (managed/pty). */
  remoteControl: boolean;
  /** Remote callers may adopt the user's external sessions (pty resume-adopt). */
  remoteAdoptExternal: boolean;
}

export function defaultControlPolicy(): ControlPolicy {
  return { remoteControl: true, remoteAdoptExternal: false };
}

/** Coerce an arbitrary object into a valid ControlPolicy (defaults for missing/ill-typed). Pure. */
export function normalizeControlPolicy(p: Partial<ControlPolicy> | null | undefined): ControlPolicy {
  const base = defaultControlPolicy();
  if (!p || typeof p !== "object") return base;
  return {
    remoteControl: typeof p.remoteControl === "boolean" ? p.remoteControl : base.remoteControl,
    remoteAdoptExternal:
      typeof p.remoteAdoptExternal === "boolean" ? p.remoteAdoptExternal : base.remoteAdoptExternal,
  };
}

function lisaHome(): string {
  return process.env.LISA_HOME ?? path.join(os.homedir(), ".lisa");
}

/** Resolved lazily so tests can point LISA_HOME at a tmp dir. */
function policyPath(): string {
  return path.join(lisaHome(), "control-policy.json");
}

/** Read the policy, merged over defaults; tolerant of a missing/corrupt file. */
export function loadControlPolicy(): ControlPolicy {
  try {
    const raw = fs.readFileSync(policyPath(), "utf8");
    return normalizeControlPolicy(JSON.parse(raw) as Partial<ControlPolicy>);
  } catch {
    return defaultControlPolicy();
  }
}

export function saveControlPolicy(p: Partial<ControlPolicy>): ControlPolicy {
  const next = normalizeControlPolicy(p);
  const file = policyPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}
