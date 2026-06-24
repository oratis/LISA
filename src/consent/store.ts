/**
 * Unified consent store (FOUNDATIONS §1 — the master constraint for Sense).
 *
 * Single source of truth at ~/.lisa/consent.json. Every sensitive ambient
 * signal source (screen / voice / clipboard / selection) must check
 * `isGranted(signal)` before it captures anything — ungranted → no-op, never
 * "capture first, ask later". Default is ALL OFF: an absent signal is denied.
 *
 * This is the framework S2 (ambient vision/voice) builds on; it ships before any
 * source so the gate exists from day one. UI surfacing (island SENSE indicator
 * + one-tap revoke) lands with the first source — the CLI (`lisa consent`) gives
 * control in the meantime.
 *
 * Back-compat: a brand-new, independent file; its absence means "nothing
 * granted", i.e. exactly the pre-existing behavior.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A sensitive ambient signal. Open-ended, but these are the canonical ones. */
export type ConsentSignal =
  | "screen"
  | "voice"
  | "clipboard"
  | "selection"
  | "mail"
  | (string & {});

/** The consent-gated signals — all OFF until the user explicitly grants each. */
export const SENSE_SIGNALS: ConsentSignal[] = ["screen", "voice", "clipboard", "selection", "mail"];

/** Human-facing "what does enabling this capture?" — shown on the consent card. */
export const SIGNAL_DESCRIPTIONS: Record<string, string> = {
  screen: "foreground app/window names and (optionally) low-frequency screenshots",
  voice: "microphone audio for push-to-talk transcription",
  clipboard: "clipboard contents when you copy",
  selection: "text you select / point at",
  mail: "headers + a short snippet of your inbox mail, to classify it and build a daily digest",
};

export interface ConsentGrant {
  granted: boolean;
  /** ISO timestamp of the most recent grant. */
  grantedAt?: string;
  /** Per-signal options (e.g. { retentionDays, everySec }). */
  options?: Record<string, unknown>;
}

export interface ConsentState {
  grants: Record<string, ConsentGrant>;
}

function lisaHome(): string {
  return process.env.LISA_HOME ?? path.join(os.homedir(), ".lisa");
}

/** Resolved lazily so tests can point LISA_HOME at a tmp dir. */
function consentPath(): string {
  return path.join(lisaHome(), "consent.json");
}

/** Read the consent state; tolerant of a missing or corrupt file (all-off). */
export function loadConsent(): ConsentState {
  let raw: string;
  try {
    raw = fs.readFileSync(consentPath(), "utf8");
  } catch {
    return { grants: {} }; // no file yet → nothing granted
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ConsentState>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.grants !== "object" || !parsed.grants) {
      return { grants: {} };
    }
    return { grants: parsed.grants as Record<string, ConsentGrant> };
  } catch {
    return { grants: {} }; // corrupt → treat as nothing granted (fail closed)
  }
}

function saveConsent(state: ConsentState): void {
  const file = consentPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

/**
 * THE GATE. True only if the signal has been explicitly granted. Absent /
 * revoked / corrupt-file → false (fail closed). Every source calls this before
 * capturing.
 */
export function isGranted(signal: ConsentSignal): boolean {
  return loadConsent().grants[signal]?.granted === true;
}

/** Grant a signal (records grantedAt + optional options). Returns new state. */
export function grant(
  signal: ConsentSignal,
  options?: Record<string, unknown>,
  now: number = Date.now(),
): ConsentState {
  const state = loadConsent();
  state.grants[signal] = {
    granted: true,
    grantedAt: new Date(now).toISOString(),
    ...(options ? { options } : {}),
  };
  saveConsent(state);
  return state;
}

/** Revoke one signal (keeps a record that it's off). Returns new state. */
export function revoke(signal: ConsentSignal): ConsentState {
  const state = loadConsent();
  state.grants[signal] = { granted: false };
  saveConsent(state);
  return state;
}

/** One-tap stop-all: flip every known grant off. Returns new state. */
export function revokeAll(): ConsentState {
  const state = loadConsent();
  for (const key of Object.keys(state.grants)) {
    state.grants[key] = { granted: false };
  }
  // Also ensure every canonical signal is explicitly recorded off, so a UI
  // listing shows them as deliberately-stopped rather than merely absent.
  for (const sig of SENSE_SIGNALS) {
    if (!state.grants[sig]) state.grants[sig] = { granted: false };
  }
  saveConsent(state);
  return state;
}

export interface ConsentRow {
  signal: string;
  granted: boolean;
  grantedAt?: string;
  options?: Record<string, unknown>;
}

/** All canonical signals + any extra recorded ones, with current status. */
export function listGrants(): ConsentRow[] {
  const state = loadConsent();
  const keys = new Set<string>([...SENSE_SIGNALS, ...Object.keys(state.grants)]);
  return [...keys].sort().map((signal) => {
    const g = state.grants[signal];
    return {
      signal,
      granted: g?.granted === true,
      ...(g?.grantedAt ? { grantedAt: g.grantedAt } : {}),
      ...(g?.options ? { options: g.options } : {}),
    };
  });
}

/**
 * Retention primitive: is a captured item past its retention window? Pure;
 * sources/cleanup call this so raw never lingers past `retentionDays`.
 * retentionDays ≤ 0 / non-finite → treated as "expire immediately" (fail safe).
 */
export function isExpired(
  capturedAtMs: number,
  retentionDays: number,
  now: number = Date.now(),
): boolean {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return true;
  return now - capturedAtMs > retentionDays * 24 * 60 * 60_000;
}
