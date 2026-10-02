/**
 * Local-time helpers for the reach-out gate: which calendar day a moment falls
 * on (the daily budget resets at local midnight) and whether it is inside the
 * user's quiet hours. All pure; the zone comes from settings (null ⇒ host zone).
 */
import { hhmmToMinutes, type QuietHours } from "./settings.js";

export interface LocalMoment {
  /** "YYYY-MM-DD" in the zone. */
  day: string;
  /** Minutes since local midnight (0–1439). */
  minutes: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(tz, f);
  }
  return f;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** The calendar day and minute-of-day of `at` in `tz` (null ⇒ the host's zone). */
export function localMoment(at: Date, tz: string | null): LocalMoment {
  if (!tz) {
    return {
      day: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
      minutes: at.getHours() * 60 + at.getMinutes(),
    };
  }
  const parts: Record<string, string> = {};
  for (const p of formatterFor(tz).formatToParts(at)) parts[p.type] = p.value;
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** Is `at` inside the quiet window? start is inclusive, end exclusive; wraps midnight. */
export function inQuietHours(at: Date, quiet: QuietHours): boolean {
  if (!quiet.enabled) return false;
  const start = hhmmToMinutes(quiet.start);
  const end = hhmmToMinutes(quiet.end);
  const { minutes } = localMoment(at, quiet.tz);
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/**
 * The instant the current quiet window ends (the next time the local clock
 * reads `quiet.end`). Only meaningful while `inQuietHours` is true. Computed as
 * a minute offset, so across a DST change it can be off by the shift — the
 * deferred queue re-checks quiet hours before releasing, which absorbs that.
 */
export function quietHoursEnd(at: Date, quiet: QuietHours): Date {
  const end = hhmmToMinutes(quiet.end);
  const { minutes } = localMoment(at, quiet.tz);
  const wait = (end - minutes + 1440) % 1440 || 1440;
  const out = new Date(at.getTime() + wait * 60_000);
  out.setSeconds(0, 0);
  return out;
}
