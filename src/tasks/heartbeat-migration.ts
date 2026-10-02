/**
 * heartbeat.json → routines, on request.
 *
 * NOT automatic. `lisa heartbeat run` keeps running the chores in
 * `~/.lisa/heartbeat.json` exactly as it always has. This module backs the
 * explicit `lisa tasks migrate-heartbeat [--dry-run]` command, for a user who
 * wants a chore's schedule honoured and its result delivered — and who accepts
 * that, until the approval layer is wired, a migrated chore can only make
 * read-only tool calls (no shell, no file writes, no MCP).
 *
 * What is never migrated: `builtin:*` entries. Those are not chores but
 * switches on Lisa's own heartbeat work (a disabled `builtin:weekly_examen`
 * keeps the examen off); moving one would silently switch the builtin back on.
 *
 * Crash safety. A chore must be runnable exactly one way at every instant:
 *
 *   1. create the routine, DISABLED        → the chore still runs from heartbeat.json
 *   2. enable the routine (one atomic write) → the heartbeat stops running the chore
 *      at that same instant, because it skips every chore whose routine has
 *      ever been enabled (stillOnHeartbeat below)
 *   3. rewrite heartbeat.json without the migrated chores (backup first)
 *
 * A crash after 1 leaves the old way; after 2, the new way; step 3 is cleanup.
 * Running the command again finishes whatever is left and changes nothing else.
 */
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isCloud } from "../edition.js";
import { atomicWrite, pathExists } from "../fs-utils.js";
import { lisaGlobalHome } from "../paths.js";
import { withFileLock } from "../soul/lock.js";
import { enableTask } from "./lifecycle.js";
import { MIN_EVERY_MS_LOCAL, parseSchedule, validateSchedule } from "./schedule.js";
import { createTask, getTask, tasksDir, updateTask } from "./store.js";
import { DEFAULT_TASK_BUDGET, type ScheduleSpec, type TaskBudget } from "./types.js";
import { LIMITS } from "./validate.js";

/** What the heartbeat's cadence is assumed to be when no launchd job is installed. */
export const DEFAULT_HEARTBEAT_INTERVAL_SEC = 1800;

/** Envelope category marking a routine that came from heartbeat.json (for the Warden wiring). */
export const HEARTBEAT_LEGACY_CATEGORY = "heartbeat-legacy";

/** The heartbeat's own default per-tick token ceiling (heartbeat/config.ts). */
const HEARTBEAT_DEFAULT_BUDGET_TOKENS = 500_000;

export const MIGRATION_WARNING =
  "Migrated chores cannot run shell, file-writing or MCP tools until the approval layer is wired: " +
  "an unattended task may only make read-only calls today. A chore that needs those tools should " +
  "stay in heartbeat.json for now.";

export interface ChorePlan {
  name: string;
  /** Position among the chores that share this name (0 for the first). */
  occurrence: number;
  id: string;
  title: string;
  schedule: ScheduleSpec;
  /** Where the schedule came from. */
  cadence: "own" | "heartbeat" | "assumed";
  budget: TaskBudget;
  enabled: boolean;
  action: "migrate" | "finish" | "already";
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

/** Stable task id for the n-th chore of a given name. */
export function heartbeatTaskId(name: string, occurrence = 0): string {
  const key = occurrence === 0 ? name : `${name}\n#${occurrence}`;
  return `hb_${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
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

interface RawChore {
  name?: unknown;
  prompt?: unknown;
  enabled?: unknown;
  schedule?: unknown;
}

const isBuiltinOverride = (name: string): boolean => name.startsWith("builtin:");

/** Assign each chore its occurrence index among chores of the same name. */
function withOccurrence<T extends RawChore>(
  chores: T[],
): Array<{ chore: T; name: string; occurrence: number }> {
  const seen = new Map<string, number>();
  return chores.map((chore) => {
    const name = typeof chore?.name === "string" ? chore.name.trim() : "";
    const occurrence = seen.get(name) ?? 0;
    seen.set(name, occurrence + 1);
    return { chore, name, occurrence };
  });
}

/**
 * The chores the heartbeat should still run itself: every one whose routine has
 * NOT been switched on. Called by the heartbeat on each tick; it is what makes
 * step 2 above the single switch-over point. Never throws — on any doubt the
 * heartbeat keeps the chore.
 */
export async function stillOnHeartbeat<T extends { name: string }>(chores: T[]): Promise<T[]> {
  const out: T[] = [];
  for (const { chore, name, occurrence } of withOccurrence(chores)) {
    let moved = false;
    if (name && !isBuiltinOverride(name)) {
      try {
        const task = await getTask(heartbeatTaskId(name, occurrence));
        moved = !!task && task.origin.kind === "heartbeat" && task.enabledAt !== undefined;
      } catch {
        moved = false;
      }
    }
    if (!moved) out.push(chore);
  }
  return out;
}

export async function migrateHeartbeatTasks(
  opts: { dryRun?: boolean; now?: number; heartbeatIntervalSec?: number | null } = {},
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

    const remaining: RawChore[] = [];
    for (const { chore, name, occurrence } of withOccurrence(chores)) {
      const prompt = typeof chore?.prompt === "string" ? chore.prompt.trim() : "";
      if (name && isBuiltinOverride(name)) {
        remaining.push(chore);
        result.left.push({ name, reason: "a switch on Lisa's own heartbeat work, not a chore" });
        continue;
      }
      if (!name || !prompt) {
        remaining.push(chore);
        result.left.push({ name: name || "(unnamed)", reason: "missing name or prompt" });
        continue;
      }
      const id = heartbeatTaskId(name, occurrence);
      const { schedule, cadence } = scheduleForChore(chore.schedule, interval);
      const enabled = chore.enabled !== false;
      const existing = await getTask(id);
      const plan: ChorePlan = {
        name,
        occurrence,
        id,
        title: (occurrence === 0 ? name : `${name} (${occurrence + 1})`).slice(0, 200),
        schedule,
        cadence,
        budget,
        enabled,
        action: !existing
          ? "migrate"
          : enabled && existing.enabledAt === undefined
            ? "finish"
            : "already",
      };
      result.chores.push(plan);
      if (dryRun) continue;

      try {
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
        if (enabled && (!existing || existing.enabledAt === undefined)) {
          await updateTask(
            id,
            (t) => {
              enableTask(t, now);
              // A chore with no schedule of its own ran on every tick, this one included.
              if (cadence !== "own") t.nextRunAt = now;
            },
            now,
          );
        }
        if (plan.action !== "already") result.migrated.push(plan.title);
      } catch (err) {
        remaining.push(chore);
        result.left.push({ name, reason: (err as Error).message.slice(0, 200) });
      }
    }

    if (dryRun) return result;
    // Step 3 — cleanup. Only when there is something to remove.
    if (remaining.length === chores.length) return result;
    let backup = `${file}.pre-tasks.bak`;
    if (await pathExists(backup)) backup = `${file}.pre-tasks.${now}.bak`;
    await fsp.writeFile(backup, original, { flag: "wx" });
    result.backup = backup;
    await atomicWrite(file, `${JSON.stringify({ ...config, tasks: remaining }, null, 2)}\n`);
    return result;
  };

  if (dryRun) return await run();
  return await withFileLock(path.join(tasksDir(), ".heartbeat-migration.lock"), run);
}

/** Human-readable account of a migration (or of what one would do). */
export function describeMigration(result: HeartbeatMigrationResult): string[] {
  const lines: string[] = [];
  const verb = result.dryRun ? "Would move" : "Moved";
  const moving = result.chores.filter((c) => c.action !== "already");
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
        `${c.enabled ? "on" : "off, as it was"}, up to ${c.budget.tokens} tokens per run.`,
    );
  }
  for (const c of result.chores.filter((x) => x.action === "already")) {
    lines.push(`"${c.title}" is already a routine (${c.id}).`);
  }
  for (const l of result.left) lines.push(`Left in heartbeat.json: "${l.name}" — ${l.reason}.`);
  if (result.backup) lines.push(`Backup of the original: ${result.backup}`);
  if (moving.length > 0) lines.push("", MIGRATION_WARNING);
  if (result.dryRun && moving.length > 0) {
    lines.push("Nothing was changed. Run `lisa tasks migrate-heartbeat` to do it.");
  }
  return lines;
}
