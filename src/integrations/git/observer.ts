/**
 * Git observer (Sense S1b — the user's actual repo work, not just AI agents).
 *
 * The orchestrator hub only saw AI-agent sessions; this widens "what Lisa can
 * see" to the user's own coding: which repo they're in, the branch, uncommitted
 * changes, unpushed commits. Like Aider it has no central store — it scans the
 * configured `watchRoots` for git repos and watches each repo's `.git` refs.
 * With no watchRoots it observes nothing. Off by default.
 *
 * State (a git working tree isn't an "agent", so we map sensibly):
 *   - uncommitted changes  → working ("N uncommitted")
 *   - clean but ahead      → waiting ("N to push")
 *   - clean & in sync      → idle ("clean")
 *   - detached HEAD        → unknown
 *
 * PRIVACY: only branch name, file PATHS (from `git status --porcelain`), and
 * ahead/behind counts are surfaced — never a diff, a commit message body, or
 * any file content.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { registerIntegration } from "../registry.js";
import type {
  AgentIntegrationConfig,
  AgentObserver,
  AgentSession,
  AgentSessionState,
  SessionActivity,
} from "../types.js";

const pexec = promisify(execFile);

const ACTIVE_WINDOW_MS = 60 * 60_000; // 1h — repos linger longer than chat sessions
const MAX_LISTED = 10;
const DEBOUNCE_MS = 400;
const MAX_DEPTH = 3;
const ACTIVITY_MAX_FILES = 10;
const REF_FILES = new Set(["HEAD", "index", "ORIG_HEAD", "MERGE_HEAD"]);

export interface GitState {
  /** null when detached / no branch. */
  branch: string | null;
  ahead: number;
  behind: number;
  /** Paths with index or worktree changes (paths only — never content). */
  changedFiles: string[];
  /** Number of staged entries. */
  staged: number;
}

/** Parse `git status --porcelain=v1 --branch` output. Pure — the unit under test. */
export function parseGitStatus(porcelain: string): GitState {
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  let staged = 0;
  const changedFiles: string[] = [];

  for (const line of porcelain.split("\n")) {
    if (!line) continue;
    if (line.startsWith("## ")) {
      const head = line.slice(3);
      const bracket = head.indexOf(" [");
      const refPart = (bracket >= 0 ? head.slice(0, bracket) : head).trim();
      if (refPart.startsWith("No commits yet on ")) {
        branch = refPart.slice("No commits yet on ".length).trim() || null;
      } else if (refPart.startsWith("HEAD") || refPart.includes("(no branch)")) {
        branch = null; // detached
      } else {
        branch = refPart.split("...")[0]!.trim() || null;
      }
      const a = head.match(/ahead (\d+)/);
      const b = head.match(/behind (\d+)/);
      if (a) ahead = parseInt(a[1]!, 10);
      if (b) behind = parseInt(b[1]!, 10);
      continue;
    }
    // "XY path" — X index status, Y worktree status; path starts at column 3.
    const x = line[0]!;
    const rest = line.slice(3).trim();
    if (!rest) continue;
    // Renames/copies: "R  old -> new" — keep the destination path.
    const p = rest.includes(" -> ") ? rest.split(" -> ")[1]!.trim() : rest;
    if (p) changedFiles.push(p);
    if (x !== " " && x !== "?") staged++;
  }
  return { branch, ahead, behind, changedFiles, staged };
}

/** Map git working-tree state onto a normalized session state. Pure. */
export function deriveGitState(g: GitState): { state: AgentSessionState; reason: string } {
  if (g.branch === null) return { state: "unknown", reason: "detached" };
  if (g.changedFiles.length > 0) {
    return { state: "working", reason: `${g.changedFiles.length} uncommitted` };
  }
  if (g.ahead > 0) return { state: "waiting", reason: `${g.ahead} to push` };
  return { state: "idle", reason: "clean" };
}

/** Tier-2 structural activity for a repo. Paths + branch only. Pure. */
export function gitActivity(g: GitState): SessionActivity {
  return {
    turnCount: g.ahead, // commits ahead of upstream ≈ progress since last push
    lastTools: [], // git has no tool calls to read; inventing them would be dishonest
    filesTouched: g.changedFiles.slice(-ACTIVITY_MAX_FILES),
    gitBranch: g.branch ?? undefined,
  };
}

/** Find git repos under a root (bounded depth; doesn't descend into a repo). */
export async function findGitRepos(root: string, maxDepth = MAX_DEPTH): Promise<string[]> {
  const out: string[] = [];
  async function rec(dir: string, depth: number): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === ".git")) {
      out.push(dir);
      return; // a repo — don't recurse into it looking for nested repos
    }
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") {
        await rec(path.join(dir, e.name), depth + 1);
      }
    }
  }
  await rec(root, 0);
  return out;
}

async function readGitStatus(repoDir: string): Promise<string | null> {
  try {
    const { stdout } = await pexec("git", ["-C", repoDir, "status", "--porcelain=v1", "--branch"], {
      timeout: 5_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null; // not a repo / git missing / timeout
  }
}

interface GitSessionInfo {
  sessionId: string;
  project: string;
  cwd: string;
  lastMtime: number;
  state: AgentSessionState;
  stateReason: string;
  activity?: SessionActivity;
}

export class GitObserver extends EventEmitter implements AgentObserver {
  readonly agent = "git";
  private roots: string[];
  private sessions = new Map<string, GitSessionInfo>();
  private watchers: fs.FSWatcher[] = [];
  private pending = new Map<string, NodeJS.Timeout>();
  private emitFn: ((s: AgentSession) => void) | null = null;
  private readonly computeActivity: boolean;

  constructor(cfg: AgentIntegrationConfig) {
    super();
    const raw = Array.isArray(cfg.watchRoots) ? cfg.watchRoots : [];
    this.roots = raw
      .filter((r): r is string => typeof r === "string")
      .map((r) => r.replace(/^~/, os.homedir()));
    this.computeActivity = cfg.visibility === "activity" || cfg.visibility === "intent";
  }

  async start(emit: (s: AgentSession) => void): Promise<void> {
    this.emitFn = emit;
    for (const root of this.roots) {
      for (const repo of await findGitRepos(root)) await this.record(repo);
      this.attach(root);
    }
  }

  list(): AgentSession[] {
    const cutoff = Date.now() - ACTIVE_WINDOW_MS;
    return [...this.sessions.values()]
      .filter((s) => s.lastMtime >= cutoff)
      .sort((a, b) => b.lastMtime - a.lastMtime)
      .slice(0, MAX_LISTED)
      .map(toAgentSession);
  }

  async stop(): Promise<void> {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  private attach(root: string): void {
    try {
      const w = fs.watch(root, { recursive: true, persistent: false }, (_e, filename) => {
        if (!filename) return;
        const parts = filename.split(path.sep);
        const gi = parts.indexOf(".git");
        if (gi < 0) return;
        const base = parts[parts.length - 1]!;
        // React to ref/index/log changes — i.e. commit / checkout / stage.
        if (!REF_FILES.has(base) && !parts.includes("logs")) return;
        const repoDir = path.join(root, ...parts.slice(0, gi));
        const prev = this.pending.get(repoDir);
        if (prev) clearTimeout(prev);
        this.pending.set(
          repoDir,
          setTimeout(() => {
            this.pending.delete(repoDir);
            void this.record(repoDir).then(() => {
              const info = this.sessions.get(repoDir);
              if (info && this.emitFn) this.emitFn(toAgentSession(info));
            });
          }, DEBOUNCE_MS),
        );
      });
      w.on("error", () => w.close());
      this.watchers.push(w);
    } catch {
      // root unwatchable → no-op
    }
  }

  private async record(repoDir: string): Promise<void> {
    const porcelain = await readGitStatus(repoDir);
    if (porcelain === null) {
      this.sessions.delete(repoDir);
      return;
    }
    const g = parseGitStatus(porcelain);
    const { state, reason } = deriveGitState(g);
    let lastMtime = Date.now();
    try {
      // The most recently touched ref/index gives "when did this repo last move".
      const stats = await Promise.all(
        ["index", "HEAD", "logs/HEAD"].map((f) =>
          fsp.stat(path.join(repoDir, ".git", f)).then(
            (s) => s.mtimeMs,
            () => 0,
          ),
        ),
      );
      lastMtime = Math.max(...stats, 0) || Date.now();
    } catch {
      // keep Date.now()
    }
    this.sessions.set(repoDir, {
      sessionId: repoDir,
      project: path.basename(repoDir),
      cwd: repoDir,
      lastMtime,
      state,
      stateReason: reason,
      activity: this.computeActivity ? gitActivity(g) : undefined,
    });
  }
}

function toAgentSession(i: GitSessionInfo): AgentSession {
  return {
    agent: "git",
    sessionId: i.sessionId,
    project: i.project,
    cwd: i.cwd,
    state: i.state,
    stateReason: i.stateReason,
    lastMtime: i.lastMtime,
    activity: i.activity,
  };
}

registerIntegration("git", (cfg) => new GitObserver(cfg));
