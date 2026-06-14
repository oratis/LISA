/**
 * Derive the current git branch for a working directory (Observer deepening
 * O-D1). The codex / opencode session formats don't record a branch the way
 * Claude Code's JSONL does, but they DO record the session's cwd — so we derive
 * the branch from disk, cheaply and safely.
 *
 * `git symbolic-ref --short HEAD` returns the branch name even before the first
 * commit, and exits non-zero on a detached HEAD / non-repo / missing git — all
 * of which map to `undefined` (honest: "no branch"). execFile (no shell) avoids
 * injection; a short TTL cache keeps us from spawning git on every record.
 *
 * PRIVACY: a branch NAME only — never a diff, commit message, or file content.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

/** cwd → last resolved branch, with the time it was resolved. */
const CACHE = new Map<string, { branch: string | undefined; at: number }>();
const TTL_MS = 30_000;
const GIT_TIMEOUT_MS = 5_000;

/** A resolver injectable into observers so their unit tests need no real git. */
export type GitBranchResolver = (
  cwd: string | undefined,
  now?: number,
) => Promise<string | undefined>;

/**
 * Current branch for `cwd`, or undefined (detached / not a repo / no git /
 * timeout). Cached for a short TTL per cwd. Pass `now` to control the clock in
 * tests.
 */
export const cwdGitBranch: GitBranchResolver = async (cwd, now = Date.now()) => {
  if (!cwd) return undefined;
  const hit = CACHE.get(cwd);
  if (hit && now - hit.at < TTL_MS) return hit.branch;
  let branch: string | undefined;
  try {
    const { stdout } = await pexec("git", ["-C", cwd, "symbolic-ref", "--short", "HEAD"], {
      timeout: GIT_TIMEOUT_MS,
    });
    branch = stdout.trim() || undefined;
  } catch {
    branch = undefined; // not a repo / detached / git missing / timeout
  }
  CACHE.set(cwd, { branch, at: now });
  return branch;
};

/** Test hook — drop the cache between cases. */
export function _clearCwdBranchCache(): void {
  CACHE.clear();
}
