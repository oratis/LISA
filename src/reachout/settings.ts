/**
 * Reach-out settings — `<lisaHome>/reachout/settings.json`.
 *
 * Schema-versioned, written atomically, and tolerant on read: a missing,
 * corrupt or ill-typed file falls back to safe defaults field by field, so a
 * bad file can never make Lisa louder than the charter's defaults.
 */
import fs from "node:fs";
import path from "node:path";
import { lisaHome } from "../paths.js";
import { atomicWrite } from "../fs-utils.js";
import {
  REACH_OUT_DIALS,
  REACH_OUT_SOURCES,
  type ReachOutDial,
  type ReachOutSource,
} from "./types.js";

export const REACH_OUT_SETTINGS_VERSION = 1;

/** Daily unsolicited budget per dial (charter §3). "off" ⇒ 0. */
export const DAILY_BUDGET: Readonly<Record<ReachOutDial, number>> = Object.freeze({
  off: 0,
  low: 1,
  normal: 3,
  high: 8,
});

export interface QuietHours {
  enabled: boolean;
  /** "HH:MM", inclusive. */
  start: string;
  /** "HH:MM", exclusive. start > end wraps past midnight. */
  end: string;
  /** IANA zone; null ⇒ the host's local zone. Also defines the budget's midnight. */
  tz: string | null;
}

export interface ReachOutChannelPrefs {
  inapp: boolean;
  push: boolean;
  im: boolean;
}

export interface ReachOutCompliance {
  /** Every proactive message is attributed to Lisa. Not switchable. */
  aiDisclosure: true;
  /** Long-session reminder interval in minutes; null ⇒ off. */
  usageReminderMinutes: number | null;
  /** Over-reliance nudges. */
  dependencyNudges: boolean;
}

export interface ReachOutSettings {
  version: number;
  dial: ReachOutDial;
  /** Per-source switches. `approval` is always on (an unseen approval blocks work). */
  sources: Record<ReachOutSource, boolean>;
  quietHours: QuietHours;
  channels: ReachOutChannelPrefs;
  /** Opt-in: let Lisa's own desire/Reve notes use push. Default in-app only. */
  desirePush: boolean;
  compliance: ReachOutCompliance;
}

export function defaultReachOutSettings(): ReachOutSettings {
  const sources = {} as Record<ReachOutSource, boolean>;
  for (const s of REACH_OUT_SOURCES) sources[s] = true;
  return {
    version: REACH_OUT_SETTINGS_VERSION,
    dial: "normal",
    sources,
    quietHours: { enabled: true, start: "22:00", end: "08:00", tz: null },
    channels: { inapp: true, push: true, im: false },
    desirePush: false,
    compliance: { aiDisclosure: true, usageReminderMinutes: null, dependencyNudges: false },
  };
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isHHMM(v: unknown): v is string {
  return typeof v === "string" && HHMM.test(v);
}

/** Minutes since midnight for a validated "HH:MM". */
export function hhmmToMinutes(v: string): number {
  const m = HHMM.exec(v);
  if (!m) throw new Error(`not HH:MM: ${v}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Coerce anything into valid settings. Unknown / ill-typed fields take their
 * default; nothing here throws. Pure.
 */
export function normalizeReachOutSettings(raw: unknown): ReachOutSettings {
  const base = defaultReachOutSettings();
  if (!isRecord(raw)) return base;

  if (typeof raw.dial === "string" && (REACH_OUT_DIALS as readonly string[]).includes(raw.dial)) {
    base.dial = raw.dial as ReachOutDial;
  }
  if (isRecord(raw.sources)) {
    for (const s of REACH_OUT_SOURCES) {
      const v = raw.sources[s];
      if (typeof v === "boolean") base.sources[s] = v;
    }
  }
  base.sources.approval = true;

  if (isRecord(raw.quietHours)) {
    const q = raw.quietHours;
    if (typeof q.enabled === "boolean") base.quietHours.enabled = q.enabled;
    // start and end are only meaningful as a pair — take both or neither.
    if (isHHMM(q.start) && isHHMM(q.end) && q.start !== q.end) {
      base.quietHours.start = q.start;
      base.quietHours.end = q.end;
    }
    if (isValidTimeZone(q.tz)) base.quietHours.tz = q.tz;
  }
  if (isRecord(raw.channels)) {
    for (const c of ["inapp", "push", "im"] as const) {
      const v = raw.channels[c];
      if (typeof v === "boolean") base.channels[c] = v;
    }
  }
  if (typeof raw.desirePush === "boolean") base.desirePush = raw.desirePush;
  if (isRecord(raw.compliance)) {
    const c = raw.compliance;
    const mins = c.usageReminderMinutes;
    if (typeof mins === "number" && Number.isInteger(mins) && mins >= 15 && mins <= 1440) {
      base.compliance.usageReminderMinutes = mins;
    }
    if (typeof c.dependencyNudges === "boolean")
      base.compliance.dependencyNudges = c.dependencyNudges;
  }
  return base;
}

/** A partial update from the API / CLI. */
export interface ReachOutSettingsPatch {
  dial?: unknown;
  sources?: unknown;
  quietHours?: unknown;
  channels?: unknown;
  desirePush?: unknown;
  compliance?: unknown;
}

/**
 * Strictly validate a patch and merge it over `current`. Unlike
 * `normalizeReachOutSettings` (tolerant, for reading disk) this REJECTS bad
 * input, so a typo in the API or CLI is reported instead of silently ignored.
 */
export function applyReachOutPatch(
  current: ReachOutSettings,
  patch: unknown,
): { ok: true; settings: ReachOutSettings } | { ok: false; error: string } {
  if (!isRecord(patch)) return { ok: false, error: "body must be a JSON object" };
  const next = normalizeReachOutSettings(current);
  const fail = (error: string) => ({ ok: false as const, error });

  for (const key of Object.keys(patch)) {
    if (
      ![
        "dial",
        "sources",
        "quietHours",
        "channels",
        "desirePush",
        "compliance",
        "version",
      ].includes(key)
    ) {
      return fail(`unknown field: ${key}`);
    }
  }
  if (patch.dial !== undefined) {
    if (
      typeof patch.dial !== "string" ||
      !(REACH_OUT_DIALS as readonly string[]).includes(patch.dial)
    ) {
      return fail(`dial must be one of ${REACH_OUT_DIALS.join(", ")}`);
    }
    next.dial = patch.dial as ReachOutDial;
  }
  if (patch.sources !== undefined) {
    if (!isRecord(patch.sources)) return fail("sources must be an object");
    for (const [name, v] of Object.entries(patch.sources)) {
      if (!(REACH_OUT_SOURCES as readonly string[]).includes(name)) {
        return fail(`unknown source: ${name}`);
      }
      if (typeof v !== "boolean") return fail(`sources.${name} must be a boolean`);
      if (name === "approval" && !v) return fail("approval cannot be turned off");
      next.sources[name as ReachOutSource] = v;
    }
  }
  if (patch.quietHours !== undefined) {
    if (!isRecord(patch.quietHours)) return fail("quietHours must be an object");
    const q = patch.quietHours;
    if (q.enabled !== undefined) {
      if (typeof q.enabled !== "boolean") return fail("quietHours.enabled must be a boolean");
      next.quietHours.enabled = q.enabled;
    }
    const start = q.start ?? next.quietHours.start;
    const end = q.end ?? next.quietHours.end;
    if (!isHHMM(start) || !isHHMM(end)) return fail("quietHours start/end must be HH:MM");
    if (start === end) return fail("quietHours start and end must differ");
    next.quietHours.start = start;
    next.quietHours.end = end;
    if (q.tz !== undefined) {
      if (q.tz === null || q.tz === "") next.quietHours.tz = null;
      else if (isValidTimeZone(q.tz)) next.quietHours.tz = q.tz;
      else return fail("quietHours.tz must be an IANA time zone or null");
    }
  }
  if (patch.channels !== undefined) {
    if (!isRecord(patch.channels)) return fail("channels must be an object");
    for (const [name, v] of Object.entries(patch.channels)) {
      if (name !== "inapp" && name !== "push" && name !== "im")
        return fail(`unknown channel: ${name}`);
      if (typeof v !== "boolean") return fail(`channels.${name} must be a boolean`);
      next.channels[name] = v;
    }
  }
  if (patch.desirePush !== undefined) {
    if (typeof patch.desirePush !== "boolean") return fail("desirePush must be a boolean");
    next.desirePush = patch.desirePush;
  }
  if (patch.compliance !== undefined) {
    if (!isRecord(patch.compliance)) return fail("compliance must be an object");
    const c = patch.compliance;
    if (c.aiDisclosure !== undefined && c.aiDisclosure !== true) {
      return fail("compliance.aiDisclosure cannot be turned off");
    }
    if (c.usageReminderMinutes !== undefined) {
      const m = c.usageReminderMinutes;
      if (m === null) next.compliance.usageReminderMinutes = null;
      else if (typeof m === "number" && Number.isInteger(m) && m >= 15 && m <= 1440) {
        next.compliance.usageReminderMinutes = m;
      } else return fail("compliance.usageReminderMinutes must be null or an integer 15–1440");
    }
    if (c.dependencyNudges !== undefined) {
      if (typeof c.dependencyNudges !== "boolean") {
        return fail("compliance.dependencyNudges must be a boolean");
      }
      next.compliance.dependencyNudges = c.dependencyNudges;
    }
  }
  return { ok: true, settings: next };
}

export function reachOutDir(home: string = lisaHome()): string {
  return path.join(home, "reachout");
}
export function reachOutSettingsPath(home: string = lisaHome()): string {
  return path.join(reachOutDir(home), "settings.json");
}

/** Read settings for a home; missing / corrupt ⇒ defaults. Never throws. */
export function loadReachOutSettings(home: string = lisaHome()): ReachOutSettings {
  try {
    return normalizeReachOutSettings(
      JSON.parse(fs.readFileSync(reachOutSettingsPath(home), "utf8")),
    );
  } catch {
    return defaultReachOutSettings();
  }
}

export async function saveReachOutSettings(
  settings: ReachOutSettings,
  home: string = lisaHome(),
): Promise<ReachOutSettings> {
  const next = normalizeReachOutSettings(settings);
  await atomicWrite(reachOutSettingsPath(home), JSON.stringify(next, null, 2) + "\n");
  return next;
}
