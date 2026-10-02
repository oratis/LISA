/**
 * heartbeat.json → routines.
 *
 * Until now the user's chores lived in `~/.lisa/heartbeat.json`: every launchd
 * tick ran ALL of them (the `schedule` field was documentation), and their
 * output went to heartbeat.log and nowhere else. This moves each one into the
 * Task Engine as a routine, so its schedule is honoured and its result is
 * delivered.
 *
 * Only USER tasks move. Lisa's own autonomy — desire pursuit, the weekly
 * examen, the desire review — is not in heartbeat.json and stays in the
 * heartbeat runner untouched.
 *
 * Safe to run on every start, from several processes:
 *   - task ids are derived from the chore's name, and creation is exclusive,
 *     so a chore is never migrated twice;
 *   - the original file is copied to a backup before it is rewritten;
 *   - the rewrite only removes the tasks that now exist as routines, and keeps
 *     every other key (budgetTokens, anything unknown) as it was;
 *   - a chore that cannot be migrated stays in heartbeat.json and keeps
 *     running the old way.
 */
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { isCloud } from "../edition.js";
import { atomicWrite, pathExists } from "../fs-utils.js";
import { lisaGlobalHome } from "../paths.js";
import { withFileLock } from "../soul/lock.js";
import { enableTask } from "./lifecycle.js";
import { parseSchedule, validateSchedule } from "./schedule.js";
import { createTask, getTask, tasksDir, updateTask } from "./store.js";
import type { ScheduleSpec } from "./types.js";

/** The cadence chores had in practice: launchd woke the heartbeat every 30 minutes. */
export const LEGACY_HEARTBEAT_SCHEDULE = "every:30m";

/** Envelope category marking a routine that came from heartbeat.json (for the Warden wiring). */
export const HEARTBEAT_LEGACY_CATEGORY = "heartbeat-legacy";

export interface HeartbeatMigrationResult {
  migrated: string[];
  /** Chores already present as routines (an earlier, interrupted migration). */
  alreadyPresent: string[];
  /** Chores left in heartbeat.json, with why. */
  left: Array<{ name: string; reason: string }>;
  backup?: string;
}

export function heartbeatFile(): string {
  return path.join(lisaGlobalHome(), "heartbeat.json");
}

/** Stable task id for a chore name. */
export function heartbeatTaskId(name: string): string {
  return `hb_${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
}

/**
 * The schedule a chore gets. Its own `schedule` when that is one the engine
 * understands (bare 5-field cron included); otherwise the old every-tick
 * behaviour, made explicit.
 */
export function scheduleForChore(raw: unknown): ScheduleSpec {
  if (typeof raw === "string" && raw.trim()) {
    const s = raw.trim();
    const candidates = [s, s.split(/\s+/).length === 5 ? `cron:${s}` : null];
    for (const expr of candidates) {
      if (expr && parseSchedule(expr) && validateSchedule({ expr }) === null) return { expr };
    }
  }
  return { expr: LEGACY_HEARTBEAT_SCHEDULE };
}

interface RawChore {
  name?: unknown;
  prompt?: unknown;
  enabled?: unknown;
  schedule?: unknown;
}

export async function migrateHeartbeatTasks(now = Date.now()): Promise<HeartbeatMigrationResult> {
  const result: HeartbeatMigrationResult = { migrated: [], alreadyPresent: [], left: [] };
  // heartbeat.json is a single-user, operator-home file. The hosted edition has none.
  if (isCloud()) return result;
  const file = heartbeatFile();
  if (!(await pathExists(file))) return result;

  return await withFileLock(path.join(tasksDir(), ".heartbeat-migration.lock"), async () => {
    let original: string;
    let config: Record<string, unknown>;
    try {
      original = await fsp.readFile(file, "utf8");
      const parsed = JSON.parse(original) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return result;
      config = parsed as Record<string, unknown>;
    } catch {
      // Unreadable or malformed: leave it for the heartbeat's own error path.
      return result;
    }
    const chores = Array.isArray(config.tasks) ? (config.tasks as RawChore[]) : [];
    if (chores.length === 0) return result;

    const remaining: RawChore[] = [];
    for (const chore of chores) {
      const name = typeof chore?.name === "string" ? chore.name.trim() : "";
      const prompt = typeof chore?.prompt === "string" ? chore.prompt.trim() : "";
      if (!name || !prompt) {
        remaining.push(chore);
        result.left.push({ name: name || "(unnamed)", reason: "missing name or prompt" });
        continue;
      }
      const id = heartbeatTaskId(name);
      if (await getTask(id)) {
        result.alreadyPresent.push(name);
        continue;
      }
      try {
        await createTask(
          {
            id,
            kind: "routine",
            title: name.slice(0, 200),
            instruction: prompt.slice(0, 8000),
            origin: { kind: "heartbeat" },
            host: "home",
            schedule: scheduleForChore(chore.schedule),
            // What the old heartbeat did with a quiet run: nothing. Keep that.
            notify: "silent_on_noop",
            envelope: { categories: [HEARTBEAT_LEGACY_CATEGORY] },
            // The user wrote this chore and it was already running: it is not a
            // model-drafted task, so it does not start disabled.
            createdDisabled: false,
          },
          now,
        );
        if (chore.enabled !== false) await updateTask(id, (t) => enableTask(t, now), now);
        result.migrated.push(name);
      } catch (err) {
        remaining.push(chore);
        result.left.push({ name, reason: (err as Error).message.slice(0, 200) });
      }
    }

    if (result.migrated.length === 0 && result.alreadyPresent.length === 0) return result;

    // Back the original up once, then drop what moved.
    let backup = `${file}.pre-tasks.bak`;
    if (await pathExists(backup)) backup = `${file}.pre-tasks.${now}.bak`;
    await fsp.writeFile(backup, original, { flag: "wx" });
    result.backup = backup;
    await atomicWrite(file, `${JSON.stringify({ ...config, tasks: remaining }, null, 2)}\n`);
    return result;
  });
}
