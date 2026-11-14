/** Best-effort Git provenance confined to each knowledge base's own repository.
 * Callers hold that KB's write lock. A failed initialization must never fall
 * back to a parent repository or prevent the actual knowledge-base write.
 * Set LISA_KB_NO_GIT=1 to disable provenance entirely.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureDir } from "../fs-utils.js";
import { kbDir } from "./paths.js";

const pexec = promisify(execFile);
const gitDisabled = () => process.env.LISA_KB_NO_GIT === "1";

async function git(root: string, args: string[]): Promise<boolean> {
  // Git's environment overrides can redirect even an explicit cwd or index.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  try {
    await pexec(
      "git",
      [
        "--git-dir=" + path.join(root, ".git"),
        "--work-tree=" + root,
        "-c",
        "core.hooksPath=" + os.devNull,
        "-c",
        "core.fsmonitor=false",
        ...args,
      ],
      {
        cwd: root,
        timeout: 10_000,
        env: {
          ...env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: os.devNull,
          GIT_ATTR_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
    return true;
  } catch {
    return false;
  }
}

async function ensureRepo(root: string): Promise<boolean> {
  try {
    await ensureDir(root);
    const dotGit = path.join(root, ".git");
    let exists = false;
    try {
      const entry = await fs.lstat(dotGit);
      // KB provenance owns a standalone repository, never a linked worktree
      // or a symlink into another project's Git directory.
      if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
      exists = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    if (!exists) {
      if (!(await git(root, ["init", "-q"]))) return false;
      if (!(await git(root, ["config", "user.name", "Lisa"]))) return false;
      if (!(await git(root, ["config", "user.email", "lisa@self"]))) return false;
      if (!(await git(root, ["config", "commit.gpgsign", "false"]))) return false;
    }
    // Do not cache readiness across homes, failed init or deletion/recreation.
    return await git(root, ["rev-parse", "--git-dir"]);
  } catch {
    return false;
  }
}

/** Idempotent and best-effort; each active home gets its own repository. */
export async function ensureKbRepo(): Promise<void> {
  if (!gitDisabled()) await ensureRepo(kbDir());
}

export async function commitKb(message: string): Promise<void> {
  if (gitDisabled()) return;
  const root = kbDir();
  if (!(await ensureRepo(root))) return;
  if (!(await git(root, ["add", "-A", "--", "."]))) return;
  await git(root, ["commit", "-q", "-m", message, "--no-gpg-sign"]);
}
