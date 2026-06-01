/**
 * repo_digest (vibe-coding) — "what actually changed?" across the repos your
 * agents are working in. The orchestrator only sees structural activity (tool
 * names, file paths); git is the source of truth for *what was produced*. This
 * wraps git so LISA can answer "what did Claude Code do today" with real
 * commits + working-tree state, per repo.
 *
 * Reads the user's own git repos (content they've asked LISA to look at) — this
 * is separate from the orchestrator's no-conversation-content privacy rule.
 */
import type { ToolDefinition } from "../types.js";
import { getCurrentHub } from "../integrations/current-hub.js";
import { runIn, isDir, gitRoot } from "./exec-util.js";

interface RepoDigestInput {
  /** Repo path. Omit to digest every repo with an observed agent session. */
  cwd?: string;
  /** git --since value. Default "1 day ago". */
  since?: string;
}

export interface RepoDigest {
  root: string;
  branch: string;
  commits: string[];
  dirtyFiles: number;
  diffStat: string;
  ahead: number;
  behind: number;
  since: string;
  error?: string;
}

/** Pure: render one repo's digest. Exported for tests. */
export function formatDigest(d: RepoDigest): string {
  const name = d.root.split("/").pop() || d.root;
  if (d.error) return `▸ ${name} — ${d.error}`;
  const lines: string[] = [];
  const sync =
    d.ahead || d.behind
      ? `  (${d.ahead ? "↑" + d.ahead : ""}${d.behind ? "↓" + d.behind : ""} vs upstream)`
      : "";
  lines.push(`▸ ${name} @ ${d.branch}${sync}`);
  if (d.commits.length) {
    lines.push(`  commits since ${d.since}:`);
    for (const c of d.commits) lines.push(`    ${c}`);
  } else {
    lines.push(`  no commits since ${d.since}`);
  }
  if (d.dirtyFiles > 0) {
    lines.push(`  uncommitted: ${d.dirtyFiles} file(s)${d.diffStat ? " · " + d.diffStat : ""}`);
  } else {
    lines.push(`  working tree clean`);
  }
  return lines.join("\n");
}

async function digestRepo(cwd: string, since: string, signal?: AbortSignal): Promise<RepoDigest> {
  const root = await gitRoot(cwd, signal);
  const base: RepoDigest = { root: root ?? cwd, branch: "?", commits: [], dirtyFiles: 0, diffStat: "", ahead: 0, behind: 0, since };
  if (!root) return { ...base, error: "not a git repo" };

  const git = (args: string[]) => runIn(root, "git", ["-C", root, ...args], { timeoutMs: 8000, signal });

  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  base.branch = branch.code === 0 ? branch.stdout.trim() || "?" : "?";

  // Commits across all refs in the window (covers agent worktrees/branches).
  const log = await git(["log", "--all", "--oneline", "--no-decorate", `--since=${since}`, "-n", "25"]);
  if (log.code === 0) {
    base.commits = log.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  }

  const status = await git(["status", "--porcelain"]);
  if (status.code === 0) {
    base.dirtyFiles = status.stdout.split("\n").filter((l) => l.trim()).length;
  }
  if (base.dirtyFiles > 0) {
    const ds = await git(["diff", "--shortstat"]);
    if (ds.code === 0) base.diffStat = ds.stdout.trim();
  }

  const ab = await git(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
  if (ab.code === 0) {
    const m = ab.stdout.trim().split(/\s+/);
    base.behind = parseInt(m[0] ?? "0", 10) || 0;
    base.ahead = parseInt(m[1] ?? "0", 10) || 0;
  }
  return base;
}

/** Collect distinct git roots from the observed agent sessions' cwds. */
async function observedRepoRoots(signal?: AbortSignal): Promise<string[]> {
  const hub = getCurrentHub();
  if (!hub) return [];
  const cwds = Array.from(
    new Set(hub.list().map((s) => s.cwd).filter((c): c is string => !!c && c.startsWith("/"))),
  );
  const roots = new Set<string>();
  for (const c of cwds) {
    const r = await gitRoot(c, signal);
    if (r) roots.add(r);
    if (roots.size >= 8) break;
  }
  return Array.from(roots);
}

export const repoDigestTool: ToolDefinition<RepoDigestInput, string> = {
  name: "repo_digest",
  description:
    "Summarise what actually changed in a git repo (or, with no cwd, every repo your agents are " +
    "working in): recent commits in a time window, current branch, uncommitted file count + diff " +
    "stat, and ahead/behind vs upstream. Use to answer 'what did <agent> / I do today', 'what's the " +
    "state of <repo>', or before reviewing/merging. Reads git only (no writes). Pair with review_diff " +
    "to see the actual changes and run_checks to verify them.",
  inputSchema: {
    type: "object",
    properties: {
      cwd: { type: "string", description: "Absolute path inside the repo. Omit to digest all repos with an active agent session." },
      since: { type: "string", description: 'git --since window, e.g. "1 day ago", "today", "3 hours ago". Default "1 day ago".' },
    },
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const since = input.since?.trim() || "1 day ago";
    let roots: string[];
    if (input.cwd) {
      if (!(await isDir(input.cwd))) return `(not a directory: ${input.cwd})`;
      roots = [input.cwd];
    } else {
      roots = await observedRepoRoots(ctx.signal);
      if (roots.length === 0) {
        // Fall back to the current working directory's repo.
        const r = await gitRoot(ctx.cwd, ctx.signal);
        if (r) roots = [r];
      }
    }
    if (roots.length === 0) return "(no git repos to digest — no active agent sessions and cwd isn't a repo)";
    const digests = await Promise.all(roots.map((r) => digestRepo(r, since, ctx.signal)));
    return digests.map(formatDigest).join("\n\n");
  },
};
