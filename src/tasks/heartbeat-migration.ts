/**
 * heartbeat.json → routines, on request.
 *
 * NOT automatic. `lisa heartbeat run` keeps running the chores in
 * `~/.lisa/heartbeat.json` exactly as it always has. This module backs the
 * explicit `lisa tasks migrate-heartbeat [--dry-run]` command, for a user who
 * wants a chore's schedule honoured and its result delivered — and who accepts
 * that, unless the server runs in Warden mode, a migrated chore can only make
 * read-only tool calls (no shell, no file writes, no MCP); with Warden on,
 * anything else asks for approval.
 *
 * What is never migrated: `builtin:*` entries. Those are not chores but
 * switches on Lisa's own heartbeat work (a disabled `builtin:weekly_examen`
 * keeps the examen off); moving one would silently switch the builtin back on.
 *
 * Identity. A chore is identified by its CONTENT — name, prompt and schedule —
 * never by its position or by its name alone: removing one chore from the file
 * must not make another one look like it. The routine's id is derived from
 * that content (heartbeatTaskId), and the heartbeat's skip rule and this
 * command's "already moved" check both go through it. Two chores with the
 * same content are the same chore: they become one routine.
 *
 * Which way a chore runs. The heartbeat skips a chore while its routine
 * exists and owns it — switched on, or switched off by the engine itself
 * (`pausedReason`: the user has been told why). A routine the user switched
 * off owns nothing: if the chore is (back) in heartbeat.json, the heartbeat
 * runs it the old way.
 *
 * Crash safety. A chore must be runnable exactly one way at every instant:
 *
 *   1. create the routine, DISABLED        → the chore still runs from heartbeat.json
 *   2. enable the routine (one atomic write) → the heartbeat stops running the chore
 *      at that same instant (stillOnHeartbeat below)
 *   3. rewrite heartbeat.json without the chores whose routine now owns them
 *      (backup first). Every other chore stays, untouched.
 *
 * A crash after 1 leaves the old way; after 2, the new way; step 3 is cleanup.
 * A chore whose routine could not be created or switched on stays in the file
 * and keeps running the old way. Running the command again finishes whatever
 * is left and changes nothing else.
 *
 * The command holds the heartbeat's run lock for its whole duration, so a
 * heartbeat tick never sees a chore half-way through the switch.
 */
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isCloud } from "../edition.js";
import { atomicWrite, pathExists } from "../fs-utils.js";
import { heartbeatRunLockPath, HEARTBEAT_RUN_LOCK_STALE_MS } from "../heartbeat/config.js";
import { lisaGlobalHome } from "../paths.js";
import { withFileLock } from "../soul/lock.js";
import { enableTask } from "./lifecycle.js";
import { MIN_EVERY_MS_LOCAL, parseSchedule, validateSchedule } from "./schedule.js";
import { createTask, getTask, updateTask } from "./store.js";
import { DEFAULT_TASK_BUDGET, type ScheduleSpec, type Task, type TaskBudget } from "./types.js";
import { LIMITS } from "./validate.js";

/** What the heartbeat's cadence is assumed to be when no launchd job is installed. */
export const DEFAULT_HEARTBEAT_INTERVAL_SEC = 1800;

/** Envelope category marking a routine that came from heartbeat.json (for the Warden wiring). */
export const HEARTBEAT_LEGACY_CATEGORY = "heartbeat-legacy";

/** The heartbeat's own default per-tick token ceiling (heartbeat/config.ts). */
const HEARTBEAT_DEFAULT_BUDGET_TOKENS = 500_000;

export const MIGRATION_WARNING =
  "Migrated chores cannot run shell, file-writing or MCP tools unless the server runs in Warden mode " +
  "(lisa serve --web --approval warden): without it an unattended task may only make read-only calls, " +
  "and with it anything else waits for your approval. A chore that needs those tools unattended should " +
  "stay in heartbeat.json for now.";

/** How long the command waits for a heartbeat tick in progress before giving up. */
export const MIGRATION_LOCK_WAIT_MS = 30_000;

export interface ChorePlan {
  name: string;
  id: string;
  title: string;
  schedule: ScheduleSpec;
  /** Where the schedule came from. */
  cadence: "own" | "heartbeat" | "assumed";
  budget: TaskBudget;
  /**
   * migrate: no routine yet. finish: the routine exists but does not own the
   * chore (a crash after step 1, or the user switched it off). already: the
   * routine owns it. duplicate: an exact copy of an earlier chore in the file.
   */
  action: "migrate" | "finish" | "already" | "duplicate";
  /** Set when the move failed: the chore stays in heartbeat.json and runs the old way. */
  error?: string;
}

export interface HeartbeatMigrationResult {
  dryRun: boolean;
  chores: ChorePlan[];
  /** Chores left in heartbeat.json, with why. */
  left: Array<{ name: string; reason: string }>;
  migrated: string[];
  backup?: string;
}

export function heartbeatFile(): string {
  return path.join(lisaGlobalHome(), "heartbeat.json");
}

/** A chore as heartbeat.json has it (any field may be missing or of the wrong type). */
export interface RawChore {
  name?: unknown;
  prompt?: unknown;
  enabled?: unknown;
  schedule?: unknown;
}

/** The content that identifies a chore. Null when it has no name or no prompt. */
function choreContent(chore: RawChore): { name: string; prompt: string; schedule: string } | null {
  const name = typeof chore?.name === "string" ? chore.name.trim() : "";
  const prompt = typeof chore?.prompt === "string" ? chore.prompt.trim() : "";
  if (!name || !prompt) return null;
  const schedule = typeof chore.schedule === "string" ? chore.schedule.trim() : "";
  return { name, prompt, schedule };
}

/**
 * The routine id of a chore, derived from its content (name, prompt and
 * schedule) — never from its position in the file. Null for a chore with no
 * name or no prompt, which is never migrated.
 */
export function heartbeatTaskId(chore: RawChore): string | null {
  const content = choreContent(chore);
  if (!content) return null;
  const key = JSON.stringify([content.name, content.prompt, content.schedule]);
  return `hb_${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

/**
 * Does this routine own its chore — so the heartbeat must not run it? While it
 * is switched on, or the engine switched it off itself (the user was told
 * why). A routine the user switched off does not.
 */
function routineOwnsChore(task: Task | null): boolean {
  return (
    !!task && task.origin.kind === "heartbeat" && (task.enabled || task.pausedReason !== undefined)
  );
}

function launchdPlist(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", "ai.lisa.heartbeat.plist");
}

/** The interval the installed heartbeat actually fires at, or null when none is installed. */
export async function installedHeartbeatIntervalSec(
  plistPath: string = launchdPlist(),
): Promise<number | null> {
  try {
    const xml = await fsp.readFile(plistPath, "utf8");
    const m = xml.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
    const sec = m ? parseInt(m[1]!, 10) : NaN;
    return Number.isFinite(sec) && sec > 0 ? sec : null;
  } catch {
    return null;
  }
}

function everyFromSeconds(sec: number): string {
  const minutes = Math.max(MIN_EVERY_MS_LOCAL / 60_000, Math.ceil(sec / 60));
  return minutes % 60 === 0 ? `every:${minutes / 60}h` : `every:${minutes}m`;
}

/**
 * The schedule a chore gets: its own when the engine understands it (bare
 * 5-field cron included); otherwise the cadence it has in practice — every
 * heartbeat tick.
 */
export function scheduleForChore(
  raw: unknown,
  heartbeatIntervalSec: number | null,
): { schedule: ScheduleSpec; cadence: ChorePlan["cadence"] } {
  if (typeof raw === "string" && raw.trim()) {
    const s = raw.trim();
    const candidates = [s, s.split(/\s+/).length === 5 ? `cron:${s}` : null];
    for (const expr of candidates) {
      if (expr && parseSchedule(expr) && validateSchedule({ expr }) === null) {
        return { schedule: { expr }, cadence: "own" };
      }
    }
  }
  return {
    schedule: { expr: everyFromSeconds(heartbeatIntervalSec ?? DEFAULT_HEARTBEAT_INTERVAL_SEC) },
    cadence: heartbeatIntervalSec === null ? "assumed" : "heartbeat",
  };
}

/**
 * The per-run budget of a migrated chore. heartbeat.json's `budgetTokens`
 * capped a whole tick; a single chore could never spend more than that, so it
 * becomes the chore's ceiling. `0` meant "no limit" — the engine has no such
 * thing, so it becomes the engine's maximum.
 */
export function budgetForChore(budgetTokens: unknown): TaskBudget {
  const { min, max } = LIMITS.tokens;
  let tokens: number;
  if (budgetTokens === undefined) tokens = HEARTBEAT_DEFAULT_BUDGET_TOKENS;
  else if (typeof budgetTokens !== "number" || !Number.isFinite(budgetTokens))
    tokens = DEFAULT_TASK_BUDGET.tokens;
  else if (budgetTokens <= 0) tokens = max;
  else tokens = budgetTokens;
  return { ...DEFAULT_TASK_BUDGET, tokens: Math.max(min, Math.min(max, Math.floor(tokens))) };
}

const isBuiltinOverride = (name: string): boolean => name.startsWith("builtin:");

/**
 * The chores the heartbeat should still run itself: every one whose routine
 * does not own it (routineOwnsChore). Called by the heartbeat on each tick;
 * it is what makes step 2 above the single switch-over point. Never throws —
 * on any doubt the heartbeat keeps the chore.
 */
export async function stillOnHeartbeat<T extends RawChore>(chores: T[]): Promise<T[]> {
  const out: T[] = [];
  for (const chore of chores) {
    let moved = false;
    const name = typeof chore?.name === "string" ? chore.name.trim() : "";
    const id = heartbeatTaskId(chore);
    if (id && !isBuiltinOverride(name)) {
      try {
        moved = routineOwnsChore(await getTask(id));
      } catch {
        moved = false;
      }
    }
    if (!moved) out.push(chore);
  }
  return out;
}

export async function migrateHeartbeatTasks(
  opts: {
    dryRun?: boolean;
    now?: number;
    heartbeatIntervalSec?: number | null;
    /** How long to wait for a heartbeat tick in progress. */
    lockWaitMs?: number;
  } = {},
): Promise<HeartbeatMigrationResult> {
  const now = opts.now ?? Date.now();
  const dryRun = opts.dryRun === true;
  const result: HeartbeatMigrationResult = { dryRun, chores: [], left: [], migrated: [] };
  // heartbeat.json is a single-user, operator-home file. The hosted edition has none.
  if (isCloud()) return result;
  const file = heartbeatFile();
  if (!(await pathExists(file))) return result;

  const run = async (): Promise<HeartbeatMigrationResult> => {
    let original: string;
    let config: Record<string, unknown>;
    try {
      original = await fsp.readFile(file, "utf8");
      const parsed = JSON.parse(original) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not a JSON object");
      }
      config = parsed as Record<string, unknown>;
    } catch (err) {
      result.left.push({
        name: "(heartbeat.json)",
        reason: `unreadable: ${(err as Error).message.slice(0, 120)}`,
      });
      return result;
    }
    const chores = Array.isArray(config.tasks) ? (config.tasks as RawChore[]) : [];
    const interval =
      opts.heartbeatIntervalSec !== undefined
        ? opts.heartbeatIntervalSec
        : await installedHeartbeatIntervalSec();
    const budget = budgetForChore(config.budgetTokens);

    const planned = new Set<string>();
    const sameName = new Map<string, number>();
    for (const chore of chores) {
      const name = typeof chore?.name === "string" ? chore.name.trim() : "";
      if (name && isBuiltinOverride(name)) {
        result.left.push({ name, reason: "a switch on Lisa's own heartbeat work, not a chore" });
        continue;
      }
      const id = heartbeatTaskId(chore);
      if (!id) {
        result.left.push({ name: name || "(unnamed)", reason: "missing name or prompt" });
        continue;
      }
      if (chore.enabled === false) {
        result.left.push({
          name,
          reason: "switched off there; turn it on and run this again to move it",
        });
        continue;
      }
      const prompt = (chore.prompt as string).trim();
      const nth = (sameName.get(name) ?? 0) + 1;
      sameName.set(name, nth);
      const { schedule, cadence } = scheduleForChore(chore.schedule, interval);
      let existing: Task | null;
      try {
        existing = await getTask(id);
      } catch (err) {
        result.left.push({ name, reason: (err as Error).message.slice(0, 200) });
        continue;
      }
      const plan: ChorePlan = {
        name,
        id,
        title: (nth === 1 ? name : `${name} (${nth})`).slice(0, 200),
        schedule,
        cadence,
        budget,
        action: planned.has(id)
          ? "duplicate"
          : !existing
            ? "migrate"
            : routineOwnsChore(existing)
              ? "already"
              : "finish",
      };
      planned.add(id);
      result.chores.push(plan);
      if (dryRun || plan.action === "duplicate" || plan.action === "already") continue;

      try {
        if (existing && existing.origin.kind !== "heartbeat") {
          throw new Error(`a task with id ${id} exists and did not come from heartbeat.json`);
        }
        // Step 1 — the routine exists but is off: the heartbeat still runs the chore.
        if (!existing) {
          await createTask(
            {
              id,
              kind: "routine",
              title: plan.title,
              instruction: prompt.slice(0, 8000),
              origin: { kind: "heartbeat" },
              host: "home",
              schedule,
              budget,
              // What the old heartbeat did with a quiet run: nothing. Keep that.
              notify: "silent_on_noop",
              envelope: { categories: [HEARTBEAT_LEGACY_CATEGORY] },
              // Written by the user, not drafted by the model.
              createdDisabled: false,
            },
            now,
          );
        }
        // Step 2 — the switch-over. From this write on, the heartbeat skips the chore.
        const switched = await updateTask(
          id,
          (t) => {
            if (t.enabled) return false;
            enableTask(t, now);
            // A chore with no schedule of its own ran on every tick, this one included.
            if (cadence !== "own") t.nextRunAt = now;
          },
          now,
        );
        if (!switched?.enabled) throw new Error("the routine could not be switched on");
        result.migrated.push(plan.title);
      } catch (err) {
        plan.error = (err as Error).message.slice(0, 200);
        result.left.push({
          name: plan.title,
          reason: `${plan.error} (it keeps running as before)`,
        });
      }
    }

    if (dryRun) return result;
    // Step 3 — cleanup: drop exactly the chores a routine now owns, checked
    // against the store, not against what this run meant to do.
    const remaining: RawChore[] = [];
    for (const chore of chores) {
      const name = typeof chore?.name === "string" ? chore.name.trim() : "";
      const id = heartbeatTaskId(chore);
      let owned = false;
      if (id && !isBuiltinOverride(name) && chore.enabled !== false) {
        owned = routineOwnsChore(await getTask(id).catch(() => null));
      }
      if (!owned) remaining.push(chore);
    }
    if (remaining.length === chores.length) return result;
    let backup = `${file}.pre-tasks.bak`;
    if (await pathExists(backup)) backup = `${file}.pre-tasks.${now}.bak`;
    await fsp.writeFile(backup, original, { flag: "wx" });
    result.backup = backup;
    await atomicWrite(file, `${JSON.stringify({ ...config, tasks: remaining }, null, 2)}\n`);
    return result;
  };

  if (dryRun) return await run();
  try {
    // The heartbeat's own run lock: no tick can run, or start, while chores move.
    return await withFileLock(heartbeatRunLockPath(), run, {
      timeoutMs: opts.lockWaitMs ?? MIGRATION_LOCK_WAIT_MS,
      staleMs: HEARTBEAT_RUN_LOCK_STALE_MS,
      pollMs: 250,
    });
  } catch (err) {
    if ((err as Error).message?.includes("timed out acquiring lock")) {
      throw new Error(
        "a heartbeat run is in progress — nothing was changed; run this again when it has finished",
        { cause: err },
      );
    }
    throw err;
  }
}

/** Human-readable account of a migration (or of what one would do). */
export function describeMigration(result: HeartbeatMigrationResult): string[] {
  const lines: string[] = [];
  const verb = result.dryRun ? "Would move" : "Moved";
  const moving = result.chores.filter(
    (c) => (c.action === "migrate" || c.action === "finish") && !c.error,
  );
  if (result.chores.length === 0 && result.left.length === 0) {
    return ["Nothing to migrate: heartbeat.json has no chores."];
  }
  for (const c of moving) {
    const cadence =
      c.cadence === "own"
        ? "its own schedule"
        : c.cadence === "heartbeat"
          ? "the installed heartbeat interval"
          : "no heartbeat job is installed, so 30 minutes is assumed";
    lines.push(
      `${verb} "${c.title}" → routine ${c.id}: ${c.schedule.expr} (${cadence}), ` +
        `up to ${c.budget.tokens} tokens per run.`,
    );
  }
  for (const c of result.chores.filter((x) => x.action === "already")) {
    lines.push(`"${c.title}" is already a routine (${c.id}).`);
  }
  for (const c of result.chores.filter((x) => x.action === "duplicate")) {
    lines.push(
      `"${c.title}" is an exact copy of an earlier chore (same name, prompt and schedule): ` +
        `both are the one routine ${c.id}.`,
    );
  }
  for (const l of result.left) lines.push(`Left in heartbeat.json: "${l.name}" — ${l.reason}.`);
  if (result.backup) lines.push(`Backup of the original: ${result.backup}`);
  if (moving.length > 0) lines.push("", MIGRATION_WARNING);
  if (result.dryRun && moving.length > 0) {
    lines.push("Nothing was changed. Run `lisa tasks migrate-heartbeat` to do it.");
  }
  return lines;
}
