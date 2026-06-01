/**
 * github (integration) — a gh-CLI-backed tool covering the GitHub operations a
 * coding agent / orchestrator actually needs beyond pr_status (list+CI) and
 * github_link (URLs): issues (list/view/create/comment), PRs (view/create/
 * comment/merge), CI runs (list/view), releases. One tool, action-dispatched.
 *
 * Read actions are safe; create/comment/merge are write actions (gated by the
 * host approval layer like any mutating tool). Needs `gh` authenticated.
 */
import type { ToolDefinition } from "../types.js";
import { runIn, isDir, gitRoot } from "./exec-util.js";

type GithubAction =
  | "issue_list" | "issue_view" | "issue_create" | "issue_comment"
  | "pr_view" | "pr_create" | "pr_comment" | "pr_merge"
  | "run_list" | "run_view" | "release_list";

interface GithubInput {
  action: GithubAction;
  cwd?: string;
  /** Issue / PR / run number (issue_view, pr_view, *_comment, pr_merge, run_view). */
  number?: number;
  title?: string;
  body?: string;
  /** pr_create base branch. */
  base?: string;
  /** issue_list / pr filter state. */
  state?: "open" | "closed" | "all";
  /** pr_merge method. Default squash. */
  merge_method?: "squash" | "merge" | "rebase";
}

/** Build the gh argv for an action (without the leading "gh"). Pure + tested. */
export function buildGhArgs(input: GithubInput): { args: string[] } | { error: string } {
  const need = (v: unknown, name: string) => v == null || v === "" ? `${input.action} needs ${name}` : null;
  switch (input.action) {
    case "issue_list":
      return { args: ["issue", "list", "--state", input.state ?? "open", "--limit", "30", "--json", "number,title,state,author,labels"] };
    case "issue_view": {
      const e = need(input.number, "a number"); if (e) return { error: e };
      return { args: ["issue", "view", String(input.number), "--comments"] };
    }
    case "issue_create": {
      const e = need(input.title, "a title"); if (e) return { error: e };
      return { args: ["issue", "create", "--title", input.title!, "--body", input.body ?? ""] };
    }
    case "issue_comment": {
      const e = need(input.number, "a number") || need(input.body, "a body"); if (e) return { error: e };
      return { args: ["issue", "comment", String(input.number), "--body", input.body!] };
    }
    case "pr_view": {
      const e = need(input.number, "a number"); if (e) return { error: e };
      return { args: ["pr", "view", String(input.number), "--comments"] };
    }
    case "pr_create": {
      const e = need(input.title, "a title"); if (e) return { error: e };
      const args = ["pr", "create", "--title", input.title!, "--body", input.body ?? ""];
      if (input.base) args.push("--base", input.base);
      return { args };
    }
    case "pr_comment": {
      const e = need(input.number, "a number") || need(input.body, "a body"); if (e) return { error: e };
      return { args: ["pr", "comment", String(input.number), "--body", input.body!] };
    }
    case "pr_merge": {
      const e = need(input.number, "a number"); if (e) return { error: e };
      return { args: ["pr", "merge", String(input.number), `--${input.merge_method ?? "squash"}`, "--delete-branch"] };
    }
    case "run_list":
      return { args: ["run", "list", "--limit", "15", "--json", "databaseId,name,status,conclusion,headBranch,event"] };
    case "run_view": {
      const e = need(input.number, "a run id (number)"); if (e) return { error: e };
      return { args: ["run", "view", String(input.number)] };
    }
    case "release_list":
      return { args: ["release", "list", "--limit", "10"] };
    default:
      return { error: `unknown action: ${input.action}` };
  }
}

/** Compact a gh --json issue/PR/run array into readable lines. */
function formatJsonList(action: GithubAction, raw: string): string {
  let arr: any[];
  try { arr = JSON.parse(raw); } catch { return raw.trim(); }
  if (!Array.isArray(arr) || arr.length === 0) return "(none)";
  if (action === "issue_list") {
    return arr.map((i) => {
      const labels = (i.labels ?? []).map((l: any) => l.name).join(", ");
      return `#${i.number} [${i.state}] ${i.title}${labels ? ` (${labels})` : ""} — @${i.author?.login ?? "?"}`;
    }).join("\n");
  }
  if (action === "run_list") {
    return arr.map((r) => {
      const s = r.conclusion || r.status || "?";
      return `${r.databaseId} ${s} · ${r.name} · ${r.headBranch} (${r.event})`;
    }).join("\n");
  }
  return raw.trim();
}

export const githubTool: ToolDefinition<GithubInput, string> = {
  name: "github",
  description:
    "GitHub operations via gh: issues (issue_list / issue_view / issue_create / issue_comment), " +
    "PRs (pr_view / pr_create / pr_comment / pr_merge), CI (run_list / run_view), releases " +
    "(release_list). For listing open PRs with CI use pr_status; for URLs use github_link. " +
    "create/comment/merge are write actions. Needs `gh` authenticated.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["issue_list", "issue_view", "issue_create", "issue_comment", "pr_view", "pr_create", "pr_comment", "pr_merge", "run_list", "run_view", "release_list"],
      },
      cwd: { type: "string", description: "Absolute path inside the repo. Defaults to the current directory." },
      number: { type: "integer", description: "Issue / PR number, or run id (per action)." },
      title: { type: "string", description: "For issue_create / pr_create." },
      body: { type: "string", description: "Body for create/comment actions." },
      base: { type: "string", description: "Base branch for pr_create." },
      state: { type: "string", enum: ["open", "closed", "all"], description: "Filter for issue_list (default open)." },
      merge_method: { type: "string", enum: ["squash", "merge", "rebase"], description: "For pr_merge (default squash)." },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const cwd = input.cwd && input.cwd.startsWith("/") ? input.cwd : ctx.cwd;
    if (!(await isDir(cwd))) return `(not a directory: ${cwd})`;
    const root = (await gitRoot(cwd, ctx.signal)) ?? cwd;

    const built = buildGhArgs(input);
    if ("error" in built) return `(${built.error})`;

    const r = await runIn(root, "gh", built.args, { timeoutMs: 30000, signal: ctx.signal, maxBytes: 200_000 });
    if (r.spawnError) return "(the `gh` CLI isn't installed — needed for GitHub operations. https://cli.github.com)";
    if (r.code !== 0) {
      const e = r.stderr.trim();
      if (/auth|login/i.test(e)) return "(`gh` isn't authenticated — run `gh auth login`)";
      return `(gh ${input.action} failed: ${e.slice(0, 250) || "unknown error"})`;
    }
    const out = r.stdout.trim();
    if (input.action === "issue_list" || input.action === "run_list") {
      return formatJsonList(input.action, r.stdout) || "(none)";
    }
    return out || "(done)";
  },
};
