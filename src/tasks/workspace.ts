/**
 * Each task works in its own folder: `<lisaHome>/task-workspaces/<taskId>/`.
 *
 * Never the server's working directory. Under Lisa.app or launchd that is `/`,
 * from a shell often `$HOME`, and a sandbox that lets a run write everywhere
 * under it lets a pre-approved shell rewrite Lisa's own task files (#422
 * review H2). The run's sandbox profile keeps the rest of the Lisa home
 * read-only (runner.ts `taskCapabilities`); Warden judges the run's paths
 * against this folder.
 *
 * The folder persists across the task's runs (a routine may keep notes there)
 * and is removed with the task.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { lisaHome } from "../paths.js";
import { isSafeId } from "./types.js";
import { TaskGoneError } from "./store.js";

export function taskWorkspacesDir(): string {
  return path.join(lisaHome(), "task-workspaces");
}

export function taskWorkspaceDir(taskId: string): string {
  if (!isSafeId(taskId)) throw new Error(`invalid task id: ${taskId}`);
  return path.join(taskWorkspacesDir(), taskId);
}

async function mkdirOnce(dir: string): Promise<void> {
  try {
    await fsp.mkdir(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

/**
 * Create the task's folder if needed and return its resolved path. Never
 * creates the home itself: a run whose account (or home) was deleted under it
 * must not bring it back, so a missing home is a `TaskGoneError`.
 */
export async function ensureTaskWorkspace(taskId: string): Promise<string> {
  const dir = taskWorkspaceDir(taskId);
  try {
    await fsp.access(lisaHome());
  } catch {
    throw new TaskGoneError("the task's home");
  }
  await mkdirOnce(taskWorkspacesDir());
  await mkdirOnce(dir);
  return await fsp.realpath(dir);
}

/** Remove the task's folder (with the task). Missing is fine. */
export async function removeTaskWorkspace(taskId: string): Promise<void> {
  if (!isSafeId(taskId)) return;
  await fsp.rm(taskWorkspaceDir(taskId), { recursive: true, force: true });
}
