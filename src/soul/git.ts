/**
 * soul git history — Phase 1.2 of AUTONOMY_ROADMAP.
 *
 * The soul directory is a git repository. Every write* in store.ts (and every
 * journal append) makes a commit so that Lisa's becoming has a literal history
 * she can read with `soul_history` / `soul_diff`.
 *
 * Failure mode: if git is unavailable or any individual commit fails, we warn
 * to stderr but never throw — the main flow must keep working.
 */
import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { pathExists } from "../fs-utils.js";
import { withFileLock } from "./lock.js";
import { soulDir } from "./paths.js";

/**
 * Cross-process lock around the add→diff→commit sequence. The in-process
 * enqueueCommit queue only serializes commits within ONE process; the web
 * server, the CLI, and a launchd heartbeat all write the same soul repo, and
 * two processes committing concurrently collide on .git/index.lock — the
 * loser's commit was silently swallowed (file written, history entry lost).
 *
 * Deliberately a DIFFERENT file from SOUL_LOCK_PATH (.write.lock): store-level
 * writers hold the soul write-lock *while* awaiting commitSoulChange, so
 * reusing the same lock here would self-deadlock. Ordering is always
 * write-lock → git-lock, never the reverse, so the two can't deadlock.
 */
const SOUL_GIT_LOCK_PATH = path.join(soulDir(), ".git-write.lock");

export type SoulCaller =
  | "birth"
  | "soul_patch"
  | "soul_journal"
  | "soul_feel"
  | "reflect"
  | "heartbeat"
  | "manual"
  | "migration";

interface CallerContext {
  caller: SoulCaller;
}

const callerStore = new AsyncLocalStorage<CallerContext>();

/**
 * Wrap an async block so that any soul write inside it commits with the given
 * caller label. Used at tool-execute boundaries (soul_patch, soul_journal, ...)
 * and at reflect / birth entry points.
 */
export async function withSoulCaller<T>(
  caller: SoulCaller,
  fn: () => Promise<T>,
): Promise<T> {
  return await callerStore.run({ caller }, fn);
}

function currentCaller(): SoulCaller {
  return callerStore.getStore()?.caller ?? "manual";
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

let gitAvailable: boolean | null = null;

async function checkGitAvailable(): Promise<boolean> {
  if (gitAvailable !== null) return gitAvailable;
  try {
    const r = await runGitRaw(["--version"], process.cwd());
    gitAvailable = r.code === 0;
  } catch {
    gitAvailable = false;
  }
  return gitAvailable;
}

function runGitRaw(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        // Don't let user's global git hooks/templates interfere with the
        // soul repo. We want a deterministic, sandbox-y repo.
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on("error", (err) =>
      resolve({ code: 1, stdout, stderr: stderr || String(err) }),
    );
  });
}

async function runGit(args: string[]): Promise<GitResult> {
  return await runGitRaw(args, soulDir());
}

/**
 * Initialize the soul repo. Idempotent — a no-op if .git already exists. Safe
 * to call on every startup. Adds a deterministic identity (Lisa <lisa@self>)
 * so commits don't depend on the user's global git config.
 */
export async function initSoulRepo(): Promise<void> {
  if (!(await checkGitAvailable())) {
    console.warn("[soul-git] git not available; soul history disabled");
    return;
  }
  if (!(await pathExists(soulDir()))) return;
  const dotGit = path.join(soulDir(), ".git");
  if (await pathExists(dotGit)) return;

  try {
    const init = await runGit(["init", "-q", "-b", "main"]);
    if (init.code !== 0) {
      // Older git versions don't support -b; fall back.
      await runGit(["init", "-q"]);
    }
    await runGit(["config", "user.email", "lisa@self"]);
    await runGit(["config", "user.name", "Lisa"]);
    await runGit(["config", "commit.gpgsign", "false"]);
    // Don't let core.fsmonitor or hook templates leak in — paranoia.
    await runGit(["config", "core.hooksPath", "/dev/null"]);
    // .gitignore for transient junk.
    const fs = await import("node:fs/promises");
    const ignorePath = path.join(soulDir(), ".gitignore");
    if (!(await pathExists(ignorePath))) {
      await fs.writeFile(
        ignorePath,
        ["*.tmp", "*.swp", ".DS_Store", ".write.lock", ".git-write.lock", ""].join("\n"),
        "utf8",
      );
    }
    await runGit(["add", "."]);
    const ts = new Date().toISOString();
    const commit = await runGit([
      "commit",
      "-q",
      "-m",
      `birth: initial soul snapshot @ ${ts}`,
      "--allow-empty",
    ]);
    if (commit.code !== 0) {
      console.warn(
        `[soul-git] initial commit failed: ${commit.stderr.trim().slice(0, 200)}`,
      );
    }
  } catch (err) {
    console.warn(
      `[soul-git] init failed: ${(err as Error).message.slice(0, 200)}`,
    );
  }
}

/**
 * Stage the file at `relPath` (relative to soulDir()) and commit if there's a
 * real diff. opKind is the high-level operation ("patch", "feel", "journal",
 * etc.). Failures are swallowed with a warn — soul history is best-effort.
 *
 * Async, but the caller is encouraged to `void` it: a slow git commit
 * shouldn't block the agent loop. We serialize commits via a tiny in-process
 * queue so concurrent writes don't race on the index.lock.
 */
export function commitSoulChange(
  relPath: string,
  opKind: string,
): Promise<void> {
  const caller = currentCaller();
  return enqueueCommit(async () => {
    if (!(await checkGitAvailable())) return;
    const dotGit = path.join(soulDir(), ".git");
    if (!(await pathExists(dotGit))) return; // not initialized yet (pre-birth)
    try {
      await withFileLock(
        SOUL_GIT_LOCK_PATH,
        async () => {
          const add = await runGit(["add", "--", relPath]);
          if (add.code !== 0) {
            // file might not exist yet (deletion case) — try -A on the relPath
            // dirname instead. If still nothing, give up quietly.
            return;
          }
          const diff = await runGit(["diff", "--cached", "--quiet", "--", relPath]);
          // exit 0 = no diff, exit 1 = diff present.
          if (diff.code === 0) return;
          const msg = formatCommitMessage(relPath, opKind, caller);
          const commit = await runGit(["commit", "-q", "-m", msg]);
          if (commit.code !== 0) {
            console.warn(
              `[soul-git] commit failed for ${relPath}: ${commit.stderr.trim().slice(0, 200)}`,
            );
          }
        },
        // Waiting out another process's commit is cheap; a commit that holds
        // the lock >30s is presumed crashed and stolen.
        { timeoutMs: 15_000, staleMs: 30_000 },
      );
    } catch (err) {
      console.warn(
        `[soul-git] commit error for ${relPath}: ${(err as Error).message.slice(0, 200)}`,
      );
    }
  });
}

function formatCommitMessage(
  relPath: string,
  opKind: string,
  caller: SoulCaller,
): string {
  return `${opKind}: ${relPath} via ${caller}`;
}

// ── tiny serial queue so commits don't race on .git/index.lock ────────────

let commitChain: Promise<void> = Promise.resolve();

function enqueueCommit(fn: () => Promise<void>): Promise<void> {
  const next = commitChain.then(fn, fn);
  // Keep the chain alive even if `fn` throws — we already swallow errors
  // inside, but be defensive.
  commitChain = next.catch(() => undefined);
  return next;
}

// ── readers used by soul_history / soul_diff tools ────────────────────────

export async function gitLogOneline(opts: {
  pathRel?: string;
  limit?: number;
  since?: string;
}): Promise<string> {
  if (!(await checkGitAvailable())) return "(git unavailable)";
  const dotGit = path.join(soulDir(), ".git");
  if (!(await pathExists(dotGit))) return "(soul history not initialized)";
  const args = ["log", "--pretty=format:%h %ad %s", "--date=iso-strict"];
  if (opts.limit) args.push(`-n`, String(opts.limit));
  if (opts.since) args.push(`--since=${opts.since}`);
  if (opts.pathRel) args.push("--", opts.pathRel);
  const r = await runGit(args);
  if (r.code !== 0) return `(git log failed: ${r.stderr.trim().slice(0, 200)})`;
  return r.stdout.trim() || "(no commits)";
}

export async function gitDiffPatch(opts: {
  pathRel?: string;
  since?: string;
  limit?: number;
}): Promise<string> {
  if (!(await checkGitAvailable())) return "(git unavailable)";
  const dotGit = path.join(soulDir(), ".git");
  if (!(await pathExists(dotGit))) return "(soul history not initialized)";
  const args = ["log", "-p", "--no-color", "--date=iso-strict"];
  if (opts.limit) args.push(`-n`, String(opts.limit));
  if (opts.since) args.push(`--since=${opts.since}`);
  if (opts.pathRel) args.push("--", opts.pathRel);
  const r = await runGit(args);
  if (r.code !== 0) {
    return `(git log -p failed: ${r.stderr.trim().slice(0, 200)})`;
  }
  // Cap output to a reasonable size for tool result.
  const MAX = 16_000;
  if (r.stdout.length > MAX) {
    return r.stdout.slice(0, MAX) + `\n\n[…truncated, ${r.stdout.length - MAX} more bytes]`;
  }
  return r.stdout.trim() || "(no diff in range)";
}

/** For tests / introspection. */
export async function _resetGitAvailableCache(): Promise<void> {
  gitAvailable = null;
}
