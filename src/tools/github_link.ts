/**
 * github_link (vibe-coding) — turn the local git context into a shareable
 * GitHub URL: the repo, a branch, a commit, a file (optionally with a line
 * range), or a PR / issue. So when LISA references "src/web/server.ts:120" or
 * "PR #58" she can hand you a clickable link instead of a path.
 *
 * URL building is pure git (parses `origin`), so it needs no gh. `open:true`
 * best-effort opens it in your browser.
 */
import path from "node:path";
import type { ToolDefinition } from "../types.js";
import { runIn, isDir, gitRoot } from "./exec-util.js";

interface GithubLinkInput {
  /** What to link: repo (default), branch, commit, file, pr, issue. */
  target?: "repo" | "branch" | "commit" | "file" | "pr" | "issue";
  cwd?: string;
  /** Branch name or commit sha; defaults to the current branch/HEAD. */
  ref?: string;
  /** For target:file — path (absolute or repo-relative). */
  path?: string;
  start_line?: number;
  end_line?: number;
  /** For target:pr/issue — the number. */
  number?: number;
  /** Also open the URL in the default browser. */
  open?: boolean;
}

export interface Remote {
  host: string;
  owner: string;
  repo: string;
}

/** Parse a git remote URL (scp or https/ssh) into host/owner/repo. Pure. */
export function parseRemote(url: string): Remote | null {
  let s = url.trim().replace(/\.git$/i, "").replace(/\/$/, "");
  // scp-like: git@github.com:owner/repo  (also ssh://git@github.com/owner/repo)
  let m = s.match(/^(?:ssh:\/\/)?[^@\s]*@([^:/]+)[:/](.+)$/i);
  if (!m) {
    // url: https://github.com/owner/repo
    m = s.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i);
  }
  if (!m) return null;
  const host = m[1]!;
  const parts = m[2]!.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return { host, owner: parts[0]!, repo: parts[1]! };
}

/** Build a GitHub URL for the given target. Pure + tested. */
export function buildUrl(
  r: Remote,
  target: NonNullable<GithubLinkInput["target"]>,
  opts: { ref?: string; path?: string; startLine?: number; endLine?: number; number?: number } = {},
): string | { error: string } {
  const base = `https://${r.host}/${r.owner}/${r.repo}`;
  switch (target) {
    case "repo":
      return base;
    case "branch":
      return opts.ref ? `${base}/tree/${encodeURIComponent(opts.ref)}` : base;
    case "commit":
      return opts.ref ? `${base}/commit/${opts.ref}` : { error: "commit needs a ref/sha" };
    case "file": {
      if (!opts.path) return { error: "file needs a path" };
      const ref = opts.ref || "HEAD";
      const cleanPath = opts.path.split("/").map(encodeURIComponent).join("/").replace(/^\//, "");
      let url = `${base}/blob/${encodeURIComponent(ref)}/${cleanPath}`;
      if (opts.startLine) {
        url += `#L${opts.startLine}`;
        if (opts.endLine && opts.endLine !== opts.startLine) url += `-L${opts.endLine}`;
      }
      return url;
    }
    case "pr":
      return opts.number ? `${base}/pull/${opts.number}` : { error: "pr needs a number" };
    case "issue":
      return opts.number ? `${base}/issues/${opts.number}` : { error: "issue needs a number" };
    default:
      return { error: `unknown target: ${target}` };
  }
}

export const githubLinkTool: ToolDefinition<GithubLinkInput, string> = {
  name: "github_link",
  description:
    "Build a shareable GitHub URL from the local git repo: target 'repo' (default), 'branch', " +
    "'commit', 'file' (path + optional start_line/end_line), 'pr' or 'issue' (number). Defaults the " +
    "ref to the current branch / HEAD. Use to give the user a clickable link to a file/line, commit, " +
    "branch, or PR you're referencing. open:true also opens it in the browser. Needs a GitHub `origin` " +
    "remote; no gh required.",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", enum: ["repo", "branch", "commit", "file", "pr", "issue"] },
      cwd: { type: "string", description: "Absolute path inside the repo. Defaults to the current directory." },
      ref: { type: "string", description: "Branch name or commit sha. Defaults to the current branch (for file/branch) or HEAD." },
      path: { type: "string", description: "For target:file — absolute or repo-relative file path." },
      start_line: { type: "integer", minimum: 1 },
      end_line: { type: "integer", minimum: 1 },
      number: { type: "integer", minimum: 1, description: "For target:pr or issue." },
      open: { type: "boolean", description: "Also open the URL in the default browser." },
    },
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const cwd = input.cwd && input.cwd.startsWith("/") ? input.cwd : ctx.cwd;
    if (!(await isDir(cwd))) return `(not a directory: ${cwd})`;
    const root = await gitRoot(cwd, ctx.signal);
    if (!root) return `(not a git repo: ${cwd})`;

    const remoteR = await runIn(root, "git", ["-C", root, "remote", "get-url", "origin"], { timeoutMs: 5000, signal: ctx.signal });
    if (remoteR.code !== 0) return "(no `origin` remote on this repo)";
    const remote = parseRemote(remoteR.stdout);
    if (!remote) return `(couldn't parse a GitHub URL from origin: ${remoteR.stdout.trim().slice(0, 120)})`;

    const target = input.target ?? "repo";

    // Resolve a default ref for branch/file when none given.
    let ref = input.ref;
    if (!ref && (target === "branch" || target === "file")) {
      const b = await runIn(root, "git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 5000, signal: ctx.signal });
      if (b.code === 0) ref = b.stdout.trim();
    }
    if (!ref && target === "commit") {
      const h = await runIn(root, "git", ["-C", root, "rev-parse", "HEAD"], { timeoutMs: 5000, signal: ctx.signal });
      if (h.code === 0) ref = h.stdout.trim();
    }

    // For file: make the path repo-relative.
    let filePath = input.path;
    if (target === "file" && filePath) {
      if (filePath.startsWith("/")) filePath = path.relative(root, filePath);
      if (filePath.startsWith("..")) return `(file is outside the repo: ${input.path})`;
    }

    const built = buildUrl(remote, target, { ref, path: filePath, startLine: input.start_line, endLine: input.end_line, number: input.number });
    if (typeof built !== "string") return `(${built.error})`;

    if (input.open) {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
      const args = process.platform === "win32" ? ["/c", "start", built] : [built];
      runIn(root, opener, args, { timeoutMs: 5000, signal: ctx.signal }).catch(() => {});
      return `${built}\n(opened in browser)`;
    }
    return built;
  },
};
