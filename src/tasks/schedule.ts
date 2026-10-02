/**
 * Schedule math for the Task Engine.
 *
 * Grammar (ScheduleSpec.expr):
 *   at:<ISO-8601>            once, at an absolute instant
 *   every:<n>(m|h|d)         fixed interval from the previous run
 *   daily:HH:MM              every day at wall-clock HH:MM
 *   weekdays:HH:MM           Mon–Fri at HH:MM
 *   weekly:<mon..sun>@HH:MM  one weekday at HH:MM
 *   cron:<m h dom mon dow>   5-field cron: numbers, `*`, lists, ranges, steps
 *
 * `every:` and `daily:` reuse the parsers in integrations/scheduled-dispatch.ts
 * so there is exactly one definition of those forms in the codebase.
 *
 * Wall-clock forms are evaluated in ScheduleSpec.tz (IANA zone; default = the
 * process's zone) with explicit DST rules, so `nextRun` is deterministic:
 *   - a local time that does not exist (spring-forward gap) fires at the same
 *     instant the pre-transition offset would have given — i.e. 02:30 on a
 *     02:00→03:00 night fires at 03:30 local. It is never skipped.
 *   - a local time that occurs twice (fall-back) fires once, on the first
 *     occurrence.
 */
import { parseDaily, parseEvery } from "../integrations/scheduled-dispatch.js";
import type { ScheduleSpec } from "./types.js";

export const MIN_EVERY_MS_LOCAL = 5 * 60_000;
export const MIN_EVERY_MS_CLOUD = 30 * 60_000;

interface CalendarSchedule {
  kind: "calendar";
  minutes: number[];
  hours: number[];
  /** null ⇒ unrestricted (`*`). */
  dom: Set<number> | null;
  months: Set<number> | null;
  dow: Set<number> | null;
}

export type ParsedSchedule =
  { kind: "at"; at: number } | { kind: "every"; everyMs: number } | CalendarSchedule;

const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function range(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let i = lo; i <= hi; i++) out.push(i);
  return out;
}

/** Parse one cron field into its sorted value list, or null when malformed. `*` ⇒ "all". */
function parseCronField(field: string, lo: number, hi: number): number[] | "all" | null {
  if (field === "*") return "all";
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const m = part.match(/^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,3}))?$/);
    if (!m) return null;
    const step = m[2] ? parseInt(m[2], 10) : 1;
    if (step < 1) return null;
    let a = lo;
    let b = hi;
    if (m[1] !== "*") {
      const [x, y] = m[1]!.split("-");
      a = parseInt(x!, 10);
      // "5/15" means "from 5 to the end, every 15"; a bare "5" is just 5.
      b = y !== undefined ? parseInt(y, 10) : m[2] ? hi : a;
    }
    if (a < lo || b > hi || a > b) return null;
    for (let v = a; v <= b; v += step) values.add(v);
  }
  return values.size ? [...values].sort((x, y) => x - y) : null;
}

function parseCron(body: string): CalendarSchedule | null {
  const fields = body.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minutes = parseCronField(fields[0]!, 0, 59);
  const hours = parseCronField(fields[1]!, 0, 23);
  const dom = parseCronField(fields[2]!, 1, 31);
  const months = parseCronField(fields[3]!, 1, 12);
  const dow = parseCronField(fields[4]!, 0, 7);
  if (!minutes || !hours || !dom || !months || !dow) return null;
  return {
    kind: "calendar",
    minutes: minutes === "all" ? range(0, 59) : minutes,
    hours: hours === "all" ? range(0, 23) : hours,
    dom: dom === "all" ? null : new Set(dom),
    months: months === "all" ? null : new Set(months),
    // cron allows 7 for Sunday.
    dow: dow === "all" ? null : new Set(dow.map((d) => d % 7)),
  };
}

function hhmm(s: string): { h: number; m: number } | null {
  return parseDaily(`daily:${s}`);
}

export function parseSchedule(expr: string): ParsedSchedule | null {
  if (typeof expr !== "string" || expr.length > 200) return null;
  const s = expr.trim();
  const lower = s.toLowerCase();

  if (lower.startsWith("at:")) {
    const at = Date.parse(s.slice(3));
    return Number.isFinite(at) ? { kind: "at", at } : null;
  }
  const everyMs = parseEvery(s);
  if (everyMs !== null) return everyMs > 0 ? { kind: "every", everyMs } : null;

  const daily = parseDaily(s);
  if (daily) {
    return {
      kind: "calendar",
      minutes: [daily.m],
      hours: [daily.h],
      dom: null,
      months: null,
      dow: null,
    };
  }
  if (lower.startsWith("weekdays:")) {
    const t = hhmm(s.slice("weekdays:".length));
    if (!t) return null;
    return {
      kind: "calendar",
      minutes: [t.m],
      hours: [t.h],
      dom: null,
      months: null,
      dow: new Set([1, 2, 3, 4, 5]),
    };
  }
  if (lower.startsWith("weekly:")) {
    const m = lower.slice("weekly:".length).match(/^([a-z]{3})@(\d{1,2}:\d{2})$/);
    if (!m) return null;
    const day = DOW_NAMES.indexOf(m[1]!);
    const t = hhmm(m[2]!);
    if (day < 0 || !t) return null;
    return {
      kind: "calendar",
      minutes: [t.m],
      hours: [t.h],
      dom: null,
      months: null,
      dow: new Set([day]),
    };
  }
  if (lower.startsWith("cron:")) return parseCron(s.slice("cron:".length));
  return null;
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Why this spec is not acceptable, or null when it is. `cloud` raises the
 * minimum `every:` interval (a tenant must not be able to schedule a model
 * call every five minutes on shared infrastructure).
 */
export function validateSchedule(
  spec: ScheduleSpec,
  opts: { cloud?: boolean } = {},
): string | null {
  if (!spec || typeof spec.expr !== "string") return "schedule.expr is required";
  const parsed = parseSchedule(spec.expr);
  if (!parsed) {
    return (
      `unrecognised schedule "${spec.expr.slice(0, 60)}" — use at:<ISO>, every:<n>(m|h|d), ` +
      `daily:HH:MM, weekdays:HH:MM, weekly:<mon..sun>@HH:MM or cron:<m h dom mon dow>`
    );
  }
  if (spec.tz !== undefined && (typeof spec.tz !== "string" || !isValidTimeZone(spec.tz))) {
    return `unknown time zone "${String(spec.tz).slice(0, 60)}"`;
  }
  const min = opts.cloud ? MIN_EVERY_MS_CLOUD : MIN_EVERY_MS_LOCAL;
  if (parsed.kind === "every" && parsed.everyMs < min) {
    return `every: interval must be at least ${min / 60_000} minutes`;
  }
  if (parsed.kind === "calendar") {
    // A cron that fires more often than the floor is the same abuse by another name.
    const tooOften = `schedule fires more often than every ${min / 60_000} minutes`;
    const mins = parsed.minutes;
    for (let i = 1; i < mins.length; i++) {
      if ((mins[i]! - mins[i - 1]!) * 60_000 < min) return tooOften;
    }
    // Across the hour boundary, when two listed hours are adjacent.
    const hours = new Set(parsed.hours);
    const adjacent = parsed.hours.some((h) => hours.has((h + 1) % 24));
    if (adjacent && hours.size > 1 && (60 - mins[mins.length - 1]! + mins[0]!) * 60_000 < min) {
      return tooOften;
    }
  }
  return null;
}

// ── time-zone arithmetic (Intl only — no dependency) ──

interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

function wallAt(utcMs: number, tz: string): Wall & { s: number } {
  const out: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(utcMs))) {
    if (p.type !== "literal") out[p.type] = parseInt(p.value, 10);
  }
  return {
    y: out.year!,
    mo: out.month!,
    d: out.day!,
    h: out.hour!,
    mi: out.minute!,
    s: out.second!,
  };
}

/** Zone offset (local − UTC) in ms at a UTC instant. */
function offsetAt(utcMs: number, tz: string): number {
  const w = wallAt(utcMs, tz);
  const floored = utcMs - (((utcMs % 1000) + 1000) % 1000);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - floored;
}

/**
 * The UTC instant of a wall-clock time in `tz`, under the DST rules in the
 * file header (gap ⇒ shifted forward, overlap ⇒ first occurrence).
 */
export function zonedTimeToUtc(w: Wall, tz: string): number {
  const naive = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  const DAY = 86_400_000;
  const before = offsetAt(naive - DAY, tz);
  const after = offsetAt(naive + DAY, tz);
  const candidates = before === after ? [naive - before] : [naive - before, naive - after];
  const valid = candidates.filter((utc) => {
    const back = wallAt(utc, tz);
    return (
      back.y === w.y && back.mo === w.mo && back.d === w.d && back.h === w.h && back.mi === w.mi
    );
  });
  if (valid.length) return Math.min(...valid);
  // Nonexistent local time: interpret it with the pre-transition offset.
  return naive - before;
}

export function defaultTimeZone(): string {
  return process.env.LISA_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function calendarDayMatches(s: CalendarSchedule, y: number, mo: number, d: number): boolean {
  if (s.months && !s.months.has(mo)) return false;
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  // Standard cron: when BOTH day-of-month and day-of-week are restricted, either matches.
  if (s.dom && s.dow) return s.dom.has(d) || s.dow.has(dow);
  if (s.dom) return s.dom.has(d);
  if (s.dow) return s.dow.has(dow);
  return true;
}

/** How far ahead a calendar search looks before concluding "never" (covers Feb 29). */
const CALENDAR_HORIZON_DAYS = 366 * 5;

function nextCalendar(s: CalendarSchedule, from: number, tz: string): number | null {
  const start = wallAt(from, tz);
  // Walk local calendar days via a UTC-noon cursor: it never crosses a date
  // boundary by accident, whatever the zone's offset or DST does.
  const cursor = new Date(Date.UTC(start.y, start.mo - 1, start.d, 12));
  // Start one day early: a gap-shifted time from "yesterday" can land after `from`.
  cursor.setUTCDate(cursor.getUTCDate() - 1);
  for (let i = 0; i <= CALENDAR_HORIZON_DAYS; i++) {
    const y = cursor.getUTCFullYear();
    const mo = cursor.getUTCMonth() + 1;
    const d = cursor.getUTCDate();
    if (calendarDayMatches(s, y, mo, d)) {
      let best: number | null = null;
      for (const h of s.hours) {
        for (const mi of s.minutes) {
          const t = zonedTimeToUtc({ y, mo, d, h, mi }, tz);
          if (t > from && (best === null || t < best)) best = t;
        }
      }
      if (best !== null) return best;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return null;
}

/**
 * The next instant strictly after `from` at which the schedule fires, or null
 * when it never fires again (a past `at:`, an unparseable spec).
 *
 * For `every:` the anchor is `from`: pass the previous run's time to get the
 * next one.
 */
export function nextRun(spec: ScheduleSpec, from: number): number | null {
  const parsed = parseSchedule(spec.expr);
  if (!parsed) return null;
  if (parsed.kind === "at") return parsed.at > from ? parsed.at : null;
  if (parsed.kind === "every") return from + parsed.everyMs;
  return nextCalendar(parsed, from, spec.tz ?? defaultTimeZone());
}

/**
 * When a newly enabled task should first run. Same as nextRun, except an
 * `at:` in the past is still honoured (it runs at the next tick) rather than
 * silently never firing.
 */
export function firstRun(spec: ScheduleSpec, now: number): number | null {
  const parsed = parseSchedule(spec.expr);
  if (!parsed) return null;
  if (parsed.kind === "at") return parsed.at;
  return nextRun(spec, now);
}

/** True for schedules that fire at most once. */
export function isOneShot(spec: ScheduleSpec): boolean {
  return parseSchedule(spec.expr)?.kind === "at";
}

/** Interval of an `every:` expression in ms, or null for any other form. */
export function everyIntervalMs(expr: string): number | null {
  const parsed = parseSchedule(expr);
  return parsed?.kind === "every" ? parsed.everyMs : null;
}
