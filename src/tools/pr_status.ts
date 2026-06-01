/**
 * pr_status (vibe-coding) — when many agents open many PRs, which are green,
 * which need review, which are failing? Wraps `gh pr list` to surface each open
 * PR's CI rollup + review decision in one glance. Read-only.
 */
import type { ToolDefinition } from "../types.js";
import { runIn, isDir, gitRoot } from "./exec-util.js";

interface PrStatusInput {
  cwd?: string;
  /** Only your own PRs (gh --author @me). Default false = all open PRs. */
  mine?: boolean;
}

interface RollupItem {
  conclusion?: string | null;
  status?: string | null;
  state?: string | null;
}
interface PR {
  number: number;
  title: string;
  headRefName: string;
  isDraft: boolean;
  reviewDecision?: string | null;
  statusCheckRollup?: RollupItem[] | null;
}

/** Pure: reduce a PR's check rollup to one of ✓ / ✗ / ⏳ / – . */
export function summarizeChecks(rollup: RollupItem[] | null | undefined): string {
  if (!rollup || rollup.length === 0) return "–";
  let fail = false;
  let pending = false;
  for (const c of rollup) {
    const concl = (c.conclusion ?? "").toUpperCase();
    const state = (c.state ?? "").toUpperCase();
    if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(concl) || ["FAILURE", "ERROR"].includes(state)) {
      fail = true;
    } else if (concl === "SUCCESS" || state === "SUCCESS") {
      // ok
    } else {
      pending = true; // queued / in_progress / pending / expected
    }
  }
  if (fail) return "✗";
  if (pending) return "⏳";
  return "✓";
}

function reviewLabel(d?: string | null): string {
  switch ((d ?? "").toUpperCase()) {
    case "APPROVED": return "approved";
    case "CHANGES_REQUESTED": return "changes requested";
    case "REVIEW_REQUIRED": return "needs review";
    default: return "no review";
  }
}

/** Pure: one PR → a readable line. Exported for tests. */
export function formatPR(pr: PR): string {
  const draft = pr.isDraft ? " (draft)" : "";
  const title = pr.title.length > 60 ? pr.title.slice(0, 57) + "…" : pr.title;
  return `#${pr.number} ${summarizeChecks(pr.statusCheckRollup)} CI · ${reviewLabel(pr.reviewDecision)} · ${title}${draft}  [${pr.headRefName}]`;
}

export const prStatusTool: ToolDefinition<PrStatusInput, string> = {
  name: "pr_status",
  description:
    "List the repo's open pull requests with each one's CI status (✓/✗/⏳) and review decision " +
    "(approved / changes requested / needs review). Use when the user asks which PRs are green, " +
    "ready to merge, failing, or waiting on review — handy when several agents have opened PRs. " +
    "Read-only; needs the `gh` CLI (authenticated). mine:true limits to your own PRs.",
  inputSchema: {
    type: "object",
    properties: {
      cwd: { type: "string", description: "Absolute path inside the repo. Defaults to the current directory." },
      mine: { type: "boolean", description: "Only your own PRs (default false = all open)." },
    },
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const cwd = input.cwd && input.cwd.startsWith("/") ? input.cwd : ctx.cwd;
    if (!(await isDir(cwd))) return `(not a directory: ${cwd})`;
    const root = (await gitRoot(cwd, ctx.signal)) ?? cwd;
    const args = [
      "pr", "list", "--state", "open", "--limit", "30",
      "--json", "number,title,headRefName,isDraft,reviewDecision,statusCheckRollup",
    ];
    if (input.mine) args.push("--author", "@me");
    const r = await runIn(root, "gh", args, { timeoutMs: 20000, signal: ctx.signal, maxBytes: 200_000 });
    if (r.spawnError) return "(the `gh` CLI isn't installed — needed for PR status. Install: https://cli.github.com)";
    if (r.code !== 0) {
      const e = r.stderr.trim();
      if (/auth|login/i.test(e)) return "(`gh` isn't authenticated — run `gh auth login`)";
      return `(gh pr list failed: ${e.slice(0, 200) || "is this a GitHub repo?"})`;
    }
    let prs: PR[];
    try {
      prs = JSON.parse(r.stdout) as PR[];
    } catch {
      return "(couldn't parse gh output)";
    }
    if (prs.length === 0) return "(no open PRs)";
    // failing first, then pending, then the rest
    const rank = (p: PR) => { const s = summarizeChecks(p.statusCheckRollup); return s === "✗" ? 0 : s === "⏳" ? 1 : 2; };
    prs.sort((a, b) => rank(a) - rank(b) || a.number - b.number);
    return `${prs.length} open PR(s):\n` + prs.map(formatPR).join("\n");
  },
};
