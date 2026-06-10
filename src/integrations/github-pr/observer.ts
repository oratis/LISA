/**
 * GitHub PR observer (O4 — class B, cloud/API agent) — proves the integration
 * registry generalizes beyond local file-tailing agents to remote work.
 *
 * A pull request behaves a lot like an autonomous agent session: it has CI
 * "working" on it, it "waits" on review, it "errors" when checks fail, and it
 * "finishes" when merged/closed. This adapter polls the GitHub API via the
 * `gh` CLI and normalizes each PR onto the same AgentSession shape every other
 * observer produces, so the hub / monitor / advisor treat it uniformly.
 *
 * Unlike Claude Code / Codex (which tail JSONL on disk), this is a POLLING
 * observer — it has no files to watch, so it refreshes on an interval and emits
 * sessions whose state changed. That's the point: the AgentObserver contract is
 * agnostic to *how* state is discovered.
 *
 * MODES
 *   - cfg.repos = ["owner/repo", …]  → `gh pr list -R … ` per repo (rich: also
 *     reads check status + review decision).
 *   - no repos                        → `gh search prs --author @me --state open`
 *     across all of GitHub (state/draft only; search has no check fields).
 *
 * SAFETY / PRIVACY: only the user's own PR metadata (number, title, branch,
 * state, check/review status) — never diff content or review prose. DISABLED by
 * default; opt in via ~/.lisa/agents.json. Graceful no-op if `gh` is missing or
 * unauthenticated (every fetch failure → empty, never throws into the hub).
 */

import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { registerIntegration } from "../registry.js";
import type {
  AgentIntegrationConfig,
  AgentObserver,
  AgentSession,
  AgentSessionState,
} from "../types.js";

const pexec = promisify(execFile);

const POLL_MS_DEFAULT = 90_000;
const ACTIVE_WINDOW_MS_DEFAULT = 14 * 24 * 60 * 60_000; // 14 days
const MAX_LISTED = 12;
const TITLE_MAX = 60;

/** Tolerant shape of a PR as returned by `gh pr list`/`gh search prs --json`. */
export interface RawPr {
  number: number;
  title?: string;
  state?: string; // OPEN | CLOSED | MERGED (or lowercase from search)
  isDraft?: boolean;
  mergedAt?: string | null;
  updatedAt?: string;
  headRefName?: string;
  reviewDecision?: string | null; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | "" | null
  statusCheckRollup?: RawCheck[] | null;
  repository?: { nameWithOwner?: string } | null;
  /** Injected by the fetcher for per-repo mode (search mode fills repository). */
  repoFullName?: string;
}

interface RawCheck {
  __typename?: string;
  status?: string; // CheckRun: QUEUED | IN_PROGRESS | COMPLETED
  conclusion?: string; // CheckRun: SUCCESS | FAILURE | …
  state?: string; // StatusContext: SUCCESS | PENDING | FAILURE | ERROR
  name?: string;
  context?: string;
}

const FAIL_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);
const PENDING_STATUSES = new Set([
  "QUEUED",
  "IN_PROGRESS",
  "PENDING",
  "WAITING",
  "REQUESTED",
]);

/** Reduce a check rollup to one verdict. Pure. */
export function classifyChecks(
  rollup: RawCheck[] | null | undefined,
): "failing" | "pending" | "passing" | "none" {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none";
  let pending = false;
  for (const c of rollup) {
    const conclusion = (c.conclusion ?? "").toUpperCase();
    const state = (c.state ?? "").toUpperCase();
    const status = (c.status ?? "").toUpperCase();
    if (FAIL_CONCLUSIONS.has(conclusion) || state === "FAILURE" || state === "ERROR") {
      return "failing"; // any failure dominates
    }
    if (
      (status && status !== "COMPLETED" && PENDING_STATUSES.has(status)) ||
      state === "PENDING"
    ) {
      pending = true;
    }
  }
  return pending ? "pending" : "passing";
}

function repoBasename(full: string | undefined): string {
  if (!full) return "github";
  const parts = full.split("/");
  return parts[parts.length - 1] || full;
}

/** Map one PR to the normalized AgentSession. Pure — the unit under test. */
export function mapPrToSession(pr: RawPr): AgentSession {
  const repoFull = pr.repoFullName ?? pr.repository?.nameWithOwner ?? undefined;
  const state = (pr.state ?? "").toUpperCase();
  const title = (pr.title ?? "").trim();
  const shortTitle =
    title.length > TITLE_MAX ? title.slice(0, TITLE_MAX - 1) + "…" : title;
  const sessionId = `${repoFull ?? "?"}#${pr.number}`;
  const label = `${repoBasename(repoFull)}#${pr.number}${shortTitle ? `: ${shortTitle}` : ""}`;
  const lastMtime = pr.updatedAt ? Date.parse(pr.updatedAt) || 0 : 0;

  let sessionState: AgentSessionState;
  let reason: string;

  if (state === "MERGED" || pr.mergedAt) {
    sessionState = "done";
    reason = "merged";
  } else if (state === "CLOSED") {
    sessionState = "done";
    reason = "closed";
  } else if (pr.isDraft) {
    sessionState = "working";
    reason = "draft";
  } else {
    const checks = classifyChecks(pr.statusCheckRollup);
    if (checks === "failing") {
      sessionState = "error";
      reason = "checks failing";
    } else if (checks === "pending") {
      sessionState = "working";
      reason = "checks running";
    } else {
      const review = (pr.reviewDecision ?? "").toUpperCase();
      sessionState = "waiting";
      reason =
        review === "CHANGES_REQUESTED"
          ? "changes requested"
          : review === "APPROVED"
            ? "approved — ready to merge"
            : "awaiting review";
    }
  }

  const session: AgentSession = {
    agent: "github-pr",
    sessionId,
    project: label,
    state: sessionState,
    stateReason: reason,
    lastMtime,
  };
  if (pr.headRefName) {
    session.activity = {
      turnCount: 0,
      lastTools: [],
      filesTouched: [],
      gitBranch: pr.headRefName,
    };
  }
  return session;
}

/** Run `gh` and return stdout, or null on any failure (missing/unauth/timeout). */
async function runGh(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await pexec("gh", args, {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 20_000,
    });
    return stdout;
  } catch {
    return null; // gh not installed, not authed, rate-limited, etc.
  }
}

/** Default fetcher: the user's open PRs, optionally scoped to configured repos. */
async function ghFetchPrs(cfg: AgentIntegrationConfig): Promise<RawPr[]> {
  const repos = Array.isArray((cfg as { repos?: unknown }).repos)
    ? ((cfg as { repos: unknown[] }).repos.filter((r) => typeof r === "string") as string[])
    : [];

  if (repos.length > 0) {
    const FIELDS =
      "number,title,state,isDraft,mergedAt,updatedAt,headRefName,reviewDecision,statusCheckRollup";
    const out: RawPr[] = [];
    for (const r of repos) {
      const s = await runGh(["pr", "list", "-R", r, "--state", "open", "--limit", "30", "--json", FIELDS]);
      if (!s) continue;
      try {
        for (const p of JSON.parse(s) as RawPr[]) {
          p.repoFullName = r;
          out.push(p);
        }
      } catch {
        /* skip unparsable repo response */
      }
    }
    return out;
  }

  // Zero-config: open PRs I authored across all of GitHub. Search has no
  // check/review fields, so these map to "awaiting review" / "draft".
  const s = await runGh([
    "search", "prs", "--author", "@me", "--state", "open", "--limit", "30",
    "--json", "number,title,state,isDraft,updatedAt,repository",
  ]);
  if (!s) return [];
  try {
    return JSON.parse(s) as RawPr[];
  } catch {
    return [];
  }
}

export interface GithubPrObserverOptions extends AgentIntegrationConfig {
  /** Override the PR fetcher (tests). */
  fetchPrs?: () => Promise<RawPr[]>;
  /** Poll interval ms. */
  pollMs?: number;
  /** Only surface PRs updated within this many ms. */
  activeWindowMs?: number;
  /** Clock override (tests). */
  now?: () => number;
}

export class GithubPrObserver extends EventEmitter implements AgentObserver {
  readonly agent = "github-pr";
  private sessions = new Map<string, AgentSession>();
  private timer: NodeJS.Timeout | null = null;
  private emitFn: ((s: AgentSession) => void) | null = null;
  private readonly fetcher: () => Promise<RawPr[]>;
  private readonly pollMs: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(cfg: GithubPrObserverOptions) {
    super();
    this.fetcher = cfg.fetchPrs ?? (() => ghFetchPrs(cfg));
    this.pollMs = typeof cfg.pollMs === "number" && cfg.pollMs > 0 ? cfg.pollMs : POLL_MS_DEFAULT;
    this.windowMs =
      typeof cfg.activeWindowMs === "number" && cfg.activeWindowMs > 0
        ? cfg.activeWindowMs
        : ACTIVE_WINDOW_MS_DEFAULT;
    this.now = cfg.now ?? Date.now;
  }

  async start(emit: (s: AgentSession) => void): Promise<void> {
    this.emitFn = emit;
    await this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref?.(); // never keep the process alive just to poll PRs
  }

  list(): AgentSession[] {
    const cutoff = this.now() - this.windowMs;
    return [...this.sessions.values()]
      .filter((s) => s.lastMtime >= cutoff)
      .sort((a, b) => b.lastMtime - a.lastMtime)
      .slice(0, MAX_LISTED);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One refresh cycle — exposed for deterministic tests. */
  async poll(): Promise<void> {
    let prs: RawPr[];
    try {
      prs = await this.fetcher();
    } catch {
      return; // never let a fetch error escape into the hub
    }
    const cutoff = this.now() - this.windowMs;
    const seen = new Set<string>();

    for (const pr of prs) {
      const s = mapPrToSession(pr);
      // Everything the fetcher returned still exists upstream (the fetchers
      // only list OPEN PRs), so mark it seen BEFORE the activity-window
      // check — a dormant-but-open PR must never trip the "dropped out →
      // closed/merged" inference below. The window only governs what gets
      // tracked/listed, not what counts as closed.
      seen.add(s.sessionId);
      if (s.lastMtime && s.lastMtime < cutoff) continue; // dormant PR — don't track/emit
      const prev = this.sessions.get(s.sessionId);
      this.sessions.set(s.sessionId, s);
      if (this.emitFn && (!prev || prev.state !== s.state || prev.lastMtime !== s.lastMtime)) {
        this.emitFn(s);
      }
    }

    // A PR that dropped out of the open set was merged or closed — emit one
    // final "done" so the advisor can note it, then forget it.
    for (const [id, prev] of [...this.sessions]) {
      if (seen.has(id)) continue;
      if (this.emitFn && prev.state !== "done") {
        this.emitFn({ ...prev, state: "done", stateReason: "closed/merged", lastMtime: this.now() });
      }
      this.sessions.delete(id);
    }
  }
}

registerIntegration("github-pr", (cfg) => new GithubPrObserver(cfg as GithubPrObserverOptions));
