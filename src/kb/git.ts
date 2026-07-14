/**
 * Best-effort git provenance for the knowledge base.
 *
 * The KB is its own git repo at ~/.lisa/kb/.git (separate from soul's). Every
 * mutation records a commit so the user can see how their knowledge evolved.
 * This is entirely best-effort: git may be missing, the repo may be in a weird
 * state, hooks may fail — none of that must ever break a KB write, so every
 * call swallows its errors. Callers already hold the KB write-lock, so commits
 * are serialized (no separate git lock needed).
 *
 * Set LISA_KB_NO_GIT=1 to disable entirely (tests, or users who don't want a repo).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { ensureDir, pathExists } from "../fs-utils.js";
import { KB_DIR } from "./paths.js";

const pexec = promisify(execFile);

function gitDisabled(): boolean {
  return process.env.LISA_KB_NO_GIT === "1";
}

async function git(args: string[]): Promise<void> {
  try {
    await pexec("git", args, { cwd: KB_DIR, timeout: 10_000 });
  } catch {
    // best-effort — provenance is a nicety, never a blocker
  }
}

let repoReady = false;

/** Idempotent: create the KB dir and init a git repo with a stable identity. */
export async function ensureKbRepo(): Promise<void> {
  if (repoReady || gitDisabled()) return;
  repoReady = true;
  try {
    await ensureDir(KB_DIR);
    if (!(await pathExists(path.join(KB_DIR, ".git")))) {
      await git(["init", "-q"]);
      await git(["config", "user.name", "Lisa"]);
      await git(["config", "user.email", "lisa@self"]);
      await git(["config", "commit.gpgsign", "false"]);
    }
  } catch {
    // ignore — commitKb calls are also best-effort
  }
}

/** Stage everything under the KB and commit. No-op if nothing changed. */
export async function commitKb(message: string): Promise<void> {
  if (gitDisabled()) return;
  await ensureKbRepo();
  await git(["add", "-A"]);
  // `git commit` exits non-zero when there's nothing staged — swallowed by git().
  await git(["commit", "-q", "-m", message, "--no-gpg-sign"]);
}
