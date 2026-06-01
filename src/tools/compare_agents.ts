/**
 * compare_agents (vibe-coding, workflow form) — run the SAME task across two or
 * more agents and compare what each produced, so you can pick the best result.
 *
 * It's a workflow, not a one-shot, because agents run for minutes:
 *   start   → make an isolated git worktree per agent (off the repo, so they
 *             don't clobber each other), launch each agent on the task, record
 *             the job. Returns immediately.
 *   status  → for each agent: live session state + how many files it has changed.
 *   collect → diff stat per agent's worktree, side by side, so you choose.
 *   cleanup → remove the worktrees + scratch branches once you've picked.
 *   list    → existing comparison jobs.
 */
import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { ToolDefinition } from "../types.js";
import { getCurrentHub } from "../integrations/current-hub.js";
import { launchAgent } from "./dispatch_agent.js";
import { runIn, gitRoot } from "./exec-util.js";
import {
  loadComparisons,
  addComparison,
  getComparison,
  removeComparison,
  newJobId,
  COMPARE_ROOT,
  type ComparisonJob,
  type ComparisonEntry,
  type CompareAgentKind,
} from "../integrations/comparisons.js";

interface CompareInput {
  action?: "start" | "status" | "collect" | "cleanup" | "list";
  task?: string;
  agents?: CompareAgentKind[];
  cwd?: string;
  id?: string;
}

/** Pure: one line summarising an entry's live status. Exported for tests. */
export function formatStatusLine(e: ComparisonEntry, state: string | null, changed: number): string {
  if (e.launchError) return `  ${e.agent}: failed to launch — ${e.launchError}`;
  const st = state ?? "no session yet";
  return `  ${e.agent}: ${st} · ${changed} file(s) changed  [${e.branch}]`;
}

/** Pure: header line for a job. Exported for tests. */
export function formatJobHeader(j: ComparisonJob): string {
  const task = j.task.length > 70 ? j.task.slice(0, 67) + "…" : j.task;
  return `compare ${j.id} (${j.entries.length} agents) in ${j.repo}\n  task: "${task}"`;
}

async function changedCount(worktree: string, signal?: AbortSignal): Promise<number> {
  const r = await runIn(worktree, "git", ["-C", worktree, "status", "--porcelain"], { timeoutMs: 8000, signal });
  return r.code === 0 ? r.stdout.split("\n").filter((l) => l.trim()).length : 0;
}

export const compareAgentsTool: ToolDefinition<CompareInput, string> = {
  name: "compare_agents",
  description:
    "Run the same task across multiple agents in isolated git worktrees and compare results — a " +
    "workflow (agents run for minutes): action:'start' (task + agents, default [claude,codex]) launches " +
    "them; 'status' (id) shows each one's live state + files changed; 'collect' (id) diffs each result " +
    "side by side so you pick a winner; 'cleanup' (id) removes the worktrees; 'list' shows jobs. Use when " +
    "the user wants to try an approach two ways, or isn't sure which agent does better. Spawns agents.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["start", "status", "collect", "cleanup", "list"] },
      task: { type: "string", description: "The shared task to give every agent (for start).", minLength: 1 },
      agents: { type: "array", items: { type: "string", enum: ["claude", "codex", "opencode", "aider"] }, description: "Agents to compare (for start). Default [claude, codex]." },
      cwd: { type: "string", description: "Absolute path in the repo to branch worktrees from (for start). Defaults to current dir." },
      id: { type: "string", description: "Comparison job id (for status/collect/cleanup)." },
    },
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const action = input.action ?? "start";

    if (action === "list") {
      const jobs = await loadComparisons();
      if (jobs.length === 0) return "(no comparison jobs)";
      return jobs.map(formatJobHeader).join("\n\n");
    }

    if (action === "start") {
      const task = input.task?.trim();
      if (!task) return "(start needs a task)";
      const agents = input.agents && input.agents.length ? Array.from(new Set(input.agents)) : (["claude", "codex"] as CompareAgentKind[]);
      if (agents.length < 2) return "(comparing needs at least 2 agents)";
      const cwd = input.cwd && input.cwd.startsWith("/") ? input.cwd : ctx.cwd;
      const repo = await gitRoot(cwd, ctx.signal);
      if (!repo) return `(not a git repo: ${cwd} — compare_agents isolates each agent in a git worktree)`;

      const id = newJobId();
      await mkdir(path.join(COMPARE_ROOT, id), { recursive: true });
      const entries: ComparisonEntry[] = [];
      for (const agent of agents) {
        const branch = `lisa-compare/${id}-${agent}`;
        const worktree = path.join(COMPARE_ROOT, id, agent);
        const wt = await runIn(repo, "git", ["-C", repo, "worktree", "add", "-b", branch, worktree, "HEAD"], { timeoutMs: 20000, signal: ctx.signal });
        if (wt.code !== 0) {
          entries.push({ agent, worktree, branch, launchError: `worktree add failed: ${wt.stderr.trim().slice(0, 120)}` });
          continue;
        }
        const r = await launchAgent(agent, task, worktree, ctx.log);
        entries.push({ agent, worktree, branch, pid: r.pid, launchError: r.error });
      }
      const job: ComparisonJob = { id, task, repo, createdAt: Date.now(), entries };
      await addComparison(job);
      const launched = entries.filter((e) => !e.launchError).map((e) => e.agent);
      const failed = entries.filter((e) => e.launchError);
      return (
        `Started comparison ${id}: ${launched.join(" vs ")} on the same task in ${repo}.\n` +
        entries.map((e) => `  ${e.agent} → ${e.launchError ? "FAILED: " + e.launchError : "pid " + e.pid + " in " + e.worktree}`).join("\n") +
        (failed.length ? "" : "") +
        `\n\nThey run in the background. Check progress with compare_agents action:'status' id:'${id}', ` +
        `then action:'collect' id:'${id}' to diff the results, and 'cleanup' when done.`
      );
    }

    // status / collect / cleanup need a job
    if (!input.id) return `(${action} needs an id — from compare_agents action:'list')`;
    const job = await getComparison(input.id);
    if (!job) return `(no comparison job matches "${input.id}")`;

    if (action === "status") {
      const hub = getCurrentHub();
      const lines: string[] = [formatJobHeader(job)];
      for (const e of job.entries) {
        const session = hub?.list().find((s) => s.cwd === e.worktree);
        const changed = await changedCount(e.worktree, ctx.signal);
        lines.push(formatStatusLine(e, session ? session.state : null, changed));
      }
      return lines.join("\n");
    }

    if (action === "collect") {
      const lines: string[] = [formatJobHeader(job), ""];
      for (const e of job.entries) {
        if (e.launchError) {
          lines.push(`── ${e.agent}: (didn't launch: ${e.launchError})`);
          continue;
        }
        const stat = await runIn(e.worktree, "git", ["-C", e.worktree, "diff", "HEAD", "--stat"], { timeoutMs: 10000, signal: ctx.signal });
        // diff HEAD misses untracked new files — list those separately so a
        // brand-new file an agent created isn't invisible in the comparison.
        const st = await runIn(e.worktree, "git", ["-C", e.worktree, "status", "--porcelain"], { timeoutMs: 8000, signal: ctx.signal });
        const untracked = st.code === 0 ? st.stdout.split("\n").filter((l) => l.startsWith("??")).map((l) => l.slice(3).trim()) : [];
        let body = stat.code === 0 && stat.stdout.trim() ? stat.stdout.trim() : "";
        if (untracked.length) body += `\n new files: ${untracked.slice(0, 10).join(", ")}${untracked.length > 10 ? ` (+${untracked.length - 10})` : ""}`;
        lines.push(`── ${e.agent} [${e.branch}] ──\n${body.trim() || "(no changes)"}`);
      }
      lines.push("", "Review one in full with review_diff cwd:'<worktree>' target:'head', then cleanup.");
      return lines.join("\n");
    }

    // cleanup
    const errs: string[] = [];
    for (const e of job.entries) {
      const rm = await runIn(job.repo, "git", ["-C", job.repo, "worktree", "remove", "--force", e.worktree], { timeoutMs: 15000, signal: ctx.signal });
      if (rm.code !== 0 && !/not a working tree|No such file/i.test(rm.stderr)) errs.push(`${e.agent}: ${rm.stderr.trim().slice(0, 80)}`);
      await runIn(job.repo, "git", ["-C", job.repo, "branch", "-D", e.branch], { timeoutMs: 8000, signal: ctx.signal });
    }
    await removeComparison(job.id);
    return errs.length ? `Cleaned up ${job.id} with warnings:\n${errs.join("\n")}` : `Cleaned up comparison ${job.id} (worktrees + scratch branches removed).`;
  },
};
