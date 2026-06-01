/**
 * review_diff (vibe-coding) — show the actual code changes in a repo (or a PR)
 * so LISA can review an agent's work: spot bugs, risky edits, leftover debug
 * code, missing tests. The natural follow-up to repo_digest ("something
 * changed") and the natural lead-in to run_checks ("does it pass?").
 *
 * Read-only. Diff output is capped so a huge change doesn't blow the context.
 */
import type { ToolDefinition } from "../types.js";
import { runIn, isDir, gitRoot } from "./exec-util.js";

interface ReviewDiffInput {
  /** Repo path. Defaults to the current working directory. */
  cwd?: string;
  /**
   * What to diff: "head" (all uncommitted vs HEAD, default), "working"
   * (unstaged only), "staged" (staged only), or any git ref/range
   * (e.g. "main...HEAD", "HEAD~3").
   */
  target?: string;
  /** Review a GitHub PR's diff instead (needs the `gh` CLI). */
  pr?: number;
  /** Max diff lines to return. Default 600. */
  max_lines?: number;
}

function gitDiffArgs(target: string): string[] {
  switch (target) {
    case "working":
      return ["diff"];
    case "staged":
      return ["diff", "--cached"];
    case "head":
    case "":
      return ["diff", "HEAD"];
    default:
      return ["diff", target];
  }
}

/** Pure: assemble the stat header + (capped) diff body. Exported for tests. */
export function assembleReview(stat: string, diff: string, maxLines: number): string {
  const header = stat.trim() ? stat.trim() : "(no changes)";
  if (!diff.trim()) return header;
  const lines = diff.split("\n");
  if (lines.length <= maxLines) return `${header}\n\n${diff.trimEnd()}`;
  const shown = lines.slice(0, maxLines).join("\n");
  return `${header}\n\n${shown}\n… [diff truncated — ${maxLines} of ${lines.length} lines shown; narrow with target or review per-file]`;
}

export const reviewDiffTool: ToolDefinition<ReviewDiffInput, string> = {
  name: "review_diff",
  description:
    "Show the actual code diff in a repo so you can review it — uncommitted changes vs HEAD by " +
    "default, or working/staged only, or any git ref/range, or a GitHub PR (pr:<n>, needs `gh`). " +
    "Use to review what an agent wrote before committing/merging: bugs, risky edits, debug leftovers, " +
    "missing tests. Read-only; output is capped. Pair with repo_digest (what changed) and run_checks " +
    "(does it pass).",
  inputSchema: {
    type: "object",
    properties: {
      cwd: { type: "string", description: "Absolute path inside the repo. Defaults to the current directory." },
      target: { type: "string", description: '"head" (default, all uncommitted), "working", "staged", or a git ref/range like "main...HEAD".' },
      pr: { type: "integer", description: "Review this GitHub PR's diff instead (needs `gh`)." },
      max_lines: { type: "integer", minimum: 50, maximum: 4000, description: "Max diff lines (default 600)." },
    },
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const cwd = input.cwd && input.cwd.startsWith("/") ? input.cwd : ctx.cwd;
    if (!(await isDir(cwd))) return `(not a directory: ${cwd})`;
    const root = await gitRoot(cwd, ctx.signal);
    if (!root) return `(not a git repo: ${cwd})`;
    const maxLines = input.max_lines ?? 600;

    if (typeof input.pr === "number") {
      const r = await runIn(root, "gh", ["pr", "diff", String(input.pr)], { timeoutMs: 20000, signal: ctx.signal, maxBytes: 200_000 });
      if (r.spawnError) return "(the `gh` CLI isn't installed — needed to fetch PR diffs)";
      if (r.code !== 0) return `(gh pr diff ${input.pr} failed: ${r.stderr.trim().slice(0, 200) || "unknown error"})`;
      return assembleReview(`PR #${input.pr} diff`, r.stdout, maxLines);
    }

    const target = (input.target ?? "head").trim();
    const args = gitDiffArgs(target);
    const stat = await runIn(root, "git", ["-C", root, ...args, "--stat"], { timeoutMs: 10000, signal: ctx.signal });
    const diff = await runIn(root, "git", ["-C", root, ...args], { timeoutMs: 15000, signal: ctx.signal, maxBytes: 200_000 });
    if (diff.code !== 0) return `(git diff failed: ${diff.stderr.trim().slice(0, 200) || "bad target?"})`;
    return assembleReview(stat.stdout, diff.stdout, maxLines);
  },
};
