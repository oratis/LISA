/**
 * Input validation for tasks — one definition shared by the HTTP API and the
 * model-facing tools, so a task created from chat obeys exactly the same
 * limits as one created from the app.
 *
 * Everything here is pure: unknown JSON in, a typed value or a short reason out.
 */
import { taskDigest } from "./confirmation.js";
import {
  MIN_EVERY_MS_CLOUD,
  MIN_EVERY_MS_LOCAL,
  parseSchedule,
  validateSchedule,
} from "./schedule.js";
import type { NewTask } from "./store.js";
import {
  DEFAULT_TASK_BUDGET,
  TASK_HOSTS,
  TASK_KINDS,
  TASK_NOTIFY,
  type ScheduleSpec,
  type Task,
  type TaskBudget,
  type TaskEnvelope,
  type TaskOrigin,
  type TriggerSpec,
  type WatchCompareMode,
} from "./types.js";

export const LIMITS = {
  title: 200,
  instruction: 8_000,
  url: 2_000,
  pattern: 300,
  listItems: 64,
  listItemLength: 200,
  tokens: { min: 1_000, max: 2_000_000, cloudMax: 400_000 },
  wallclockMs: { min: 10_000, max: 60 * 60_000, cloudMax: 15 * 60_000 },
  maxToolCalls: { min: 1, max: 200, cloudMax: 60 },
} as const;

export interface ValidateContext {
  /** Hosted edition: tighter budgets, a higher schedule floor, no watchers. */
  cloud: boolean;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function text(v: unknown, field: string, max: number): Result<string> {
  if (typeof v !== "string" || !v.trim()) return fail(`${field} is required`);
  if (v.length > max) return fail(`${field} is too long (max ${max} characters)`);
  return { ok: true, value: v.trim() };
}

function stringList(v: unknown, field: string): Result<string[] | undefined> {
  if (v === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(v) || v.length > LIMITS.listItems) {
    return fail(`${field} must be a list of at most ${LIMITS.listItems} strings`);
  }
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string" || !item.trim() || item.length > LIMITS.listItemLength) {
      return fail(
        `${field} entries must be non-empty strings of at most ${LIMITS.listItemLength} characters`,
      );
    }
    out.push(item.trim());
  }
  return { ok: true, value: out };
}

export function parseScheduleSpec(v: unknown, ctx: ValidateContext): Result<ScheduleSpec> {
  // A bare string is accepted as shorthand for { expr }.
  const spec = typeof v === "string" ? { expr: v } : v;
  if (!isObject(spec) || typeof spec.expr !== "string") return fail("schedule.expr is required");
  if (spec.tz !== undefined && typeof spec.tz !== "string")
    return fail("schedule.tz must be a string");
  const value: ScheduleSpec = { expr: spec.expr.trim(), ...(spec.tz ? { tz: spec.tz } : {}) };
  const problem = validateSchedule(value, { cloud: ctx.cloud });
  return problem ? fail(problem) : { ok: true, value };
}

const WATCH_MODES: readonly WatchCompareMode[] = [
  "changed",
  "appears",
  "disappears",
  "above",
  "below",
];

function httpUrl(v: unknown, field: string): Result<string> {
  if (typeof v !== "string" || v.length > LIMITS.url) return fail(`${field} must be a URL`);
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return fail(`${field} is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return fail(`${field} must be http(s)`);
  if (url.username || url.password) return fail(`${field} must not carry credentials`);
  return { ok: true, value: url.toString() };
}

export function parseTriggerSpec(v: unknown, ctx: ValidateContext): Result<TriggerSpec> {
  if (!isObject(v) || typeof v.kind !== "string") return fail("trigger.kind is required");
  if (ctx.cloud) return fail("watchers are not available in the hosted edition yet");

  let every: string | undefined;
  if (v.every !== undefined) {
    if (typeof v.every !== "string") return fail("trigger.every must be a string like every:30m");
    const parsed = parseSchedule(v.every.trim());
    if (parsed?.kind !== "every") return fail("trigger.every must be of the form every:<n>(m|h|d)");
    const floor = ctx.cloud ? MIN_EVERY_MS_CLOUD : MIN_EVERY_MS_LOCAL;
    if (parsed.everyMs < floor)
      return fail(`trigger.every must be at least ${floor / 60_000} minutes`);
    every = v.every.trim();
  }
  if (v.onHit !== undefined && v.onHit !== "notify" && v.onHit !== "run") {
    return fail('trigger.onHit must be "notify" or "run"');
  }
  const onHit = v.onHit === "notify" || v.onHit === "run" ? v.onHit : undefined;
  const common: { every?: string; onHit?: "notify" | "run" } = {
    ...(every ? { every } : {}),
    ...(onHit ? { onHit } : {}),
  };

  if (v.kind === "web") {
    const url = httpUrl(v.url, "trigger.url");
    if (!url.ok) return url;
    const mode = v.mode ?? "changed";
    if (!WATCH_MODES.includes(mode as WatchCompareMode)) {
      return fail(`trigger.mode must be one of ${WATCH_MODES.join(", ")}`);
    }
    for (const field of ["selector", "regex", "contains"] as const) {
      const value = v[field];
      if (
        value !== undefined &&
        (typeof value !== "string" || !value || value.length > LIMITS.pattern)
      ) {
        return fail(`trigger.${field} must be a string of at most ${LIMITS.pattern} characters`);
      }
    }
    if (typeof v.regex === "string") {
      try {
        new RegExp(v.regex);
      } catch {
        return fail("trigger.regex is not a valid regular expression");
      }
    }
    if (
      typeof v.selector === "string" &&
      !/^(?:[a-zA-Z][a-zA-Z0-9]*)?(?:[#.][\w-]+)*$/.test(v.selector)
    ) {
      return fail("trigger.selector supports only tag, #id and .class (e.g. span.price, #stock)");
    }
    if ((mode === "appears" || mode === "disappears") && !v.contains && !v.regex) {
      return fail(`trigger.mode "${mode as string}" needs trigger.contains or trigger.regex`);
    }
    if (mode === "above" || mode === "below") {
      if (typeof v.threshold !== "number" || !Number.isFinite(v.threshold)) {
        return fail(`trigger.mode "${mode}" needs a numeric trigger.threshold`);
      }
    }
    return {
      ok: true,
      value: {
        kind: "web",
        url: url.value,
        mode: mode as WatchCompareMode,
        ...(typeof v.selector === "string" ? { selector: v.selector } : {}),
        ...(typeof v.regex === "string" ? { regex: v.regex } : {}),
        ...(typeof v.contains === "string" ? { contains: v.contains } : {}),
        ...(typeof v.threshold === "number" ? { threshold: v.threshold } : {}),
        ...common,
      },
    };
  }

  if (v.kind === "rss") {
    const url = httpUrl(v.url, "trigger.url");
    if (!url.ok) return url;
    const keywords = stringList(v.keywords, "trigger.keywords");
    if (!keywords.ok) return keywords;
    return {
      ok: true,
      value: {
        kind: "rss",
        url: url.value,
        ...(keywords.value ? { keywords: keywords.value } : {}),
        ...common,
      },
    };
  }

  if (v.kind === "mail") {
    for (const field of ["from", "subject"] as const) {
      const value = v[field];
      if (
        value !== undefined &&
        (typeof value !== "string" || !value.trim() || value.length > LIMITS.pattern)
      ) {
        return fail(
          `trigger.${field} must be a non-empty string of at most ${LIMITS.pattern} characters`,
        );
      }
    }
    if (!v.from && !v.subject) return fail("a mail trigger needs trigger.from or trigger.subject");
    return {
      ok: true,
      value: {
        kind: "mail",
        ...(typeof v.from === "string" ? { from: v.from.trim() } : {}),
        ...(typeof v.subject === "string" ? { subject: v.subject.trim() } : {}),
        ...common,
      },
    };
  }
  return fail('trigger.kind must be "web", "rss" or "mail"');
}

export function parseEnvelope(v: unknown): Result<TaskEnvelope> {
  if (!isObject(v)) return fail("envelope must be an object");
  const out: TaskEnvelope = {};
  for (const field of ["categories", "tools", "targets"] as const) {
    const list = stringList(v[field], `envelope.${field}`);
    if (!list.ok) return list;
    if (list.value) out[field] = list.value;
  }
  return { ok: true, value: out };
}

export function parseBudget(
  v: unknown,
  ctx: ValidateContext,
  base: TaskBudget = DEFAULT_TASK_BUDGET,
): Result<TaskBudget> {
  if (!isObject(v)) return fail("budget must be an object");
  const out: TaskBudget = { ...base };
  for (const field of ["tokens", "wallclockMs", "maxToolCalls"] as const) {
    const value = v[field];
    if (value === undefined) continue;
    const { min, max, cloudMax } = LIMITS[field];
    const ceiling = ctx.cloud ? cloudMax : max;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > ceiling) {
      return fail(`budget.${field} must be an integer between ${min} and ${ceiling}`);
    }
    out[field] = value;
  }
  if (v.usdMicros !== undefined) {
    if (typeof v.usdMicros !== "number" || !Number.isInteger(v.usdMicros) || v.usdMicros < 1) {
      return fail("budget.usdMicros must be a positive integer");
    }
    out.usdMicros = v.usdMicros;
  }
  return { ok: true, value: out };
}

/** The default budget for this edition (the cloud ceiling is lower than the local default). */
export function defaultBudget(ctx: ValidateContext): TaskBudget {
  if (!ctx.cloud) return { ...DEFAULT_TASK_BUDGET };
  return {
    tokens: Math.min(DEFAULT_TASK_BUDGET.tokens, LIMITS.tokens.cloudMax),
    wallclockMs: Math.min(DEFAULT_TASK_BUDGET.wallclockMs, LIMITS.wallclockMs.cloudMax),
    maxToolCalls: Math.min(DEFAULT_TASK_BUDGET.maxToolCalls, LIMITS.maxToolCalls.cloudMax),
  };
}

function shapeProblem(
  kind: Task["kind"],
  schedule?: ScheduleSpec,
  trigger?: TriggerSpec,
): string | null {
  if (kind === "watcher" && !trigger) return "a watcher needs a trigger";
  if (kind !== "watcher" && trigger) return "only a watcher takes a trigger";
  if (kind === "routine" && !schedule) return "a routine needs a schedule";
  if (kind === "routine" && schedule && parseSchedule(schedule.expr)?.kind === "at") {
    return 'a routine repeats — use kind "oneoff" for an at: schedule';
  }
  return null;
}

/**
 * Validate the body of a create request. The result is always DISABLED: the
 * caller decides whether this origin may enable a task (the API may, the model
 * may not).
 */
export function parseNewTask(
  body: unknown,
  ctx: ValidateContext & { origin: TaskOrigin; owner: string | null },
): Result<NewTask> {
  if (!isObject(body)) return fail("body must be a JSON object");
  const kind = body.kind ?? (body.trigger ? "watcher" : body.schedule ? "routine" : "oneoff");
  if (!TASK_KINDS.includes(kind as Task["kind"]))
    return fail(`kind must be one of ${TASK_KINDS.join(", ")}`);
  const title = text(body.title, "title", LIMITS.title);
  if (!title.ok) return title;
  const instruction = text(body.instruction, "instruction", LIMITS.instruction);
  if (!instruction.ok) return instruction;

  const value: NewTask = {
    kind: kind as Task["kind"],
    title: title.value,
    instruction: instruction.value,
    origin: ctx.origin,
    owner: ctx.owner,
    budget: defaultBudget(ctx),
    enabled: false,
  };
  if (body.host !== undefined) {
    if (!TASK_HOSTS.includes(body.host as Task["host"]))
      return fail(`host must be one of ${TASK_HOSTS.join(", ")}`);
    value.host = body.host as Task["host"];
  }
  if (body.notify !== undefined) {
    if (!TASK_NOTIFY.includes(body.notify as Task["notify"])) {
      return fail(`notify must be one of ${TASK_NOTIFY.join(", ")}`);
    }
    value.notify = body.notify as Task["notify"];
  }
  if (body.schedule !== undefined) {
    const schedule = parseScheduleSpec(body.schedule, ctx);
    if (!schedule.ok) return schedule;
    value.schedule = schedule.value;
  }
  if (body.trigger !== undefined) {
    const trigger = parseTriggerSpec(body.trigger, ctx);
    if (!trigger.ok) return trigger;
    value.trigger = trigger.value;
  }
  if (body.envelope !== undefined) {
    const envelope = parseEnvelope(body.envelope);
    if (!envelope.ok) return envelope;
    value.envelope = envelope.value;
  }
  if (body.budget !== undefined) {
    const budget = parseBudget(body.budget, ctx, value.budget);
    if (!budget.ok) return budget;
    value.budget = budget.value;
  }
  const problem = shapeProblem(value.kind, value.schedule, value.trigger);
  return problem ? fail(problem) : { ok: true, value };
}

/** Fields a PATCH may carry besides `enabled`. */
const EDITABLE = [
  "title",
  "instruction",
  "schedule",
  "trigger",
  "envelope",
  "budget",
  "notify",
  "host",
] as const;

/**
 * Apply an edit to a task in place. Returns a reason when the edit is not
 * acceptable (the task is then unchanged), or null. `enabled` is NOT handled
 * here — enabling is a lifecycle transition the caller performs after this.
 */
export function applyTaskEdit(task: Task, body: unknown, ctx: ValidateContext): string | null {
  if (!isObject(body)) return "body must be a JSON object";
  const next: Task = structuredClone(task);
  for (const key of Object.keys(body)) {
    if (key !== "enabled" && !(EDITABLE as readonly string[]).includes(key)) {
      return `"${key.slice(0, 40)}" is not an editable field`;
    }
  }
  if (body.title !== undefined) {
    const title = text(body.title, "title", LIMITS.title);
    if (!title.ok) return title.error;
    next.title = title.value;
  }
  if (body.instruction !== undefined) {
    const instruction = text(body.instruction, "instruction", LIMITS.instruction);
    if (!instruction.ok) return instruction.error;
    next.instruction = instruction.value;
  }
  if (body.notify !== undefined) {
    if (!TASK_NOTIFY.includes(body.notify as Task["notify"]))
      return `notify must be one of ${TASK_NOTIFY.join(", ")}`;
    next.notify = body.notify as Task["notify"];
  }
  if (body.host !== undefined) {
    if (!TASK_HOSTS.includes(body.host as Task["host"]))
      return `host must be one of ${TASK_HOSTS.join(", ")}`;
    next.host = body.host as Task["host"];
  }
  if (body.schedule !== undefined) {
    if (body.schedule === null) delete next.schedule;
    else {
      const schedule = parseScheduleSpec(body.schedule, ctx);
      if (!schedule.ok) return schedule.error;
      next.schedule = schedule.value;
    }
  }
  if (body.trigger !== undefined) {
    const trigger = parseTriggerSpec(body.trigger, ctx);
    if (!trigger.ok) return trigger.error;
    next.trigger = trigger.value;
    // A different condition starts from a clean slate — old fingerprints would misfire.
    delete next.watch;
  }
  if (body.envelope !== undefined) {
    if (body.envelope === null) delete next.envelope;
    else {
      const envelope = parseEnvelope(body.envelope);
      if (!envelope.ok) return envelope.error;
      next.envelope = envelope.value;
    }
  }
  if (body.budget !== undefined) {
    const budget = parseBudget(body.budget, ctx, next.budget);
    if (!budget.ok) return budget.error;
    next.budget = budget.value;
  }
  const problem = shapeProblem(next.kind, next.schedule, next.trigger);
  if (problem) return problem;
  // A confirmation covers the task as the user saw it. Changing what it runs,
  // when, with which envelope or how it tells them clears it: the envelope is
  // a restriction again until they confirm the new version.
  if (taskDigest(next) !== taskDigest(task)) delete next.envelopeConfirmation;
  Object.assign(task, next);
  if (!next.schedule) delete task.schedule;
  if (!next.envelope) delete task.envelope;
  if (!next.watch) delete task.watch;
  if (!next.envelopeConfirmation) delete task.envelopeConfirmation;
  return null;
}
