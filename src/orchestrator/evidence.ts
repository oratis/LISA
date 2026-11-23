/**
 * W7 Coding Outer Loop 2.0 — completion evidence gate & PR-patrol helper/preset.
 *
 * 1. `verifyCompletionEvidence` enforces structured completion evidence
 *    (`testPassed`, `screenshotPath`, `prUrl`) before marking a coding task
 *    verified-done — preventing agents from claiming "done" without test pass,
 *    screenshot artifact, and PR link.
 * 2. `buildPrPatrolSummary` (and `PR_PATROL_PRESET`) summarizes open PR health
 *    (failing CI, merge conflicts, review feedback, low-risk auto-merge
 *    eligibility gated on explicit repo authorization, and suggested agent
 *    routing for fixes). Stays silent when nothing needs attention.
 */

import fs from "node:fs";
import path from "node:path";
import { classifyChecks, type RawPrCheck } from "../integrations/github-pr/checks.js";
import { recommendAgentForTask, type DispatchBackend } from "./capabilities.js";

export type EvidenceField = "testPassed" | "screenshotPath" | "prUrl";

export interface CompletionEvidenceInput {
  /** Whether the relevant automated tests/checks passed. */
  testPassed?: boolean;
  /** Optional command/summary recorded for the passing run. */
  testCommand?: string;
  /** Filesystem path to a screenshot/artifact proving visual/UI verification. */
  screenshotPath?: string | null;
  /** Pull request URL (`https://...`). */
  prUrl?: string | null;
}

export interface EvidenceFileStat {
  isFile: boolean;
  size: number;
}

export interface EvidencePolicy {
  /** Require `testPassed === true` (default true). */
  requireTestPassed?: boolean;
  /** Require a valid `screenshotPath` (default true). */
  requireScreenshot?: boolean;
  /** Require a valid `prUrl` (default true). */
  requirePrUrl?: boolean;
  /**
   * When true, stat `screenshotPath` on disk and require it to be a non-empty
   * regular file (default false so pure callers/fixtures need not touch disk).
   */
  verifyScreenshotOnDisk?: boolean;
  /** Optional custom file stat function for testing on-disk verification. */
  statFile?: (filePath: string) => EvidenceFileStat | null;
}

export interface CompletionEvidenceResult {
  verified: boolean;
  status: "verified-done" | "incomplete";
  missing: EvidenceField[];
  errors: string[];
  summary: string;
  evidence: {
    testPassed: boolean;
    testCommand?: string;
    screenshotPath: string | null;
    prUrl: string | null;
  };
}

function defaultStatFile(filePath: string): EvidenceFileStat | null {
  try {
    const st = fs.statSync(filePath);
    return { isFile: st.isFile(), size: st.size };
  } catch {
    return null;
  }
}

/** Validate a screenshot path string (no URLs, no NUL bytes, non-empty basename). Pure. */
export function isValidScreenshotPath(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes("\0") || trimmed.startsWith("-")) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return false;
  const base = path.basename(trimmed);
  return base.length > 0 && base !== "." && base !== "..";
}

/** Validate an https PR URL (no embedded credentials, must point to a PR path). Pure. */
export function isValidPrUrl(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  return /\/(?:pull|pulls|merge_requests)\/\d+(?:[/?#]|$)/i.test(parsed.pathname);
}

/**
 * Verify structured completion evidence (`testPassed`, `screenshotPath`, `prUrl`)
 * before marking a coding task `verified-done`.
 */
export function verifyCompletionEvidence(
  input: CompletionEvidenceInput | null | undefined,
  policy: EvidencePolicy = {},
): CompletionEvidenceResult {
  const ev = input ?? {};
  const requireTest = policy.requireTestPassed !== false;
  const requireShot = policy.requireScreenshot !== false;
  const requirePr = policy.requirePrUrl !== false;

  const missing: EvidenceField[] = [];
  const errors: string[] = [];

  const testPassed = ev.testPassed === true;
  if (requireTest && !testPassed) {
    missing.push("testPassed");
    errors.push(
      ev.testPassed === false
        ? "tests failed (`testPassed: false`)"
        : "missing passing test verification (`testPassed: true` required)",
    );
  }

  let normalizedShot: string | null = null;
  if (typeof ev.screenshotPath === "string" && ev.screenshotPath.trim().length > 0) {
    const trimmed = ev.screenshotPath.trim();
    if (!isValidScreenshotPath(trimmed)) {
      missing.push("screenshotPath");
      errors.push("invalid `screenshotPath` (must be a local file path, not a URL or flag)");
    } else if (policy.verifyScreenshotOnDisk) {
      const stat = (policy.statFile ?? defaultStatFile)(trimmed);
      if (!stat || !stat.isFile || stat.size <= 0) {
        missing.push("screenshotPath");
        errors.push(`screenshot file missing or empty on disk: ${trimmed}`);
      } else {
        normalizedShot = trimmed;
      }
    } else {
      normalizedShot = trimmed;
    }
  } else if (requireShot) {
    missing.push("screenshotPath");
    errors.push("missing `screenshotPath` evidence");
  }

  let normalizedPr: string | null = null;
  if (typeof ev.prUrl === "string" && ev.prUrl.trim().length > 0) {
    const trimmed = ev.prUrl.trim();
    if (!isValidPrUrl(trimmed)) {
      missing.push("prUrl");
      errors.push(
        "invalid `prUrl` (must be an https PR URL, e.g. https://github.com/owner/repo/pull/123)",
      );
    } else {
      normalizedPr = trimmed;
    }
  } else if (requirePr) {
    missing.push("prUrl");
    errors.push("missing `prUrl` evidence");
  }

  const verified = errors.length === 0;
  const status = verified ? "verified-done" : "incomplete";
  const summary = verified
    ? `verified-done: tests passed${ev.testCommand ? ` (${ev.testCommand})` : ""}` +
      `${normalizedShot ? `, screenshot=${normalizedShot}` : ""}` +
      `${normalizedPr ? `, pr=${normalizedPr}` : ""}`
    : `incomplete (${missing.join(", ")}): ${errors.join("; ")}`;

  return {
    verified,
    status,
    missing,
    errors,
    summary,
    evidence: {
      testPassed,
      ...(ev.testCommand ? { testCommand: ev.testCommand } : {}),
      screenshotPath: normalizedShot,
      prUrl: normalizedPr,
    },
  };
}

/** Boolean convenience helper for completion-evidence gating. */
export function canMarkVerifiedDone(
  input: CompletionEvidenceInput | null | undefined,
  policy: EvidencePolicy = {},
): boolean {
  return verifyCompletionEvidence(input, policy).verified;
}

/** Assert completion evidence passes, throwing a descriptive error if incomplete. */
export function assertCompletionEvidence(
  input: CompletionEvidenceInput | null | undefined,
  policy: EvidencePolicy = {},
): CompletionEvidenceResult {
  const result = verifyCompletionEvidence(input, policy);
  if (!result.verified) {
    throw new Error(`Cannot mark task verified-done: ${result.summary}`);
  }
  return result;
}

// ── W7 PR Patrol helper & preset ────────────────────────────────────────────

export interface PatrolPrInput {
  number: number;
  title?: string;
  url?: string;
  state?: string;
  isDraft?: boolean;
  headRefName?: string;
  baseRefName?: string;
  updatedAt?: string;
  repoFullName?: string;
  repository?: { nameWithOwner?: string } | null;
  reviewDecision?: string | null;
  mergeable?: string | null;
  mergeStateStatus?: string | null;
  statusCheckRollup?: RawPrCheck[] | null;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  files?: Array<{ path?: string }>;
  labels?: Array<{ name?: string } | string>;
  /** Optional completion evidence attached to this PR's coding task. */
  evidence?: CompletionEvidenceInput;
}

export interface PrPatrolOptions {
  /** Repos explicitly authorized for low-risk auto-merge recommendations (owner/repo). */
  autoMergeRepos?: readonly string[];
  /** Explicit authorization override when patrolling a single pre-authorized repo. */
  autoMergeAuthorized?: boolean;
  /** Max changed files allowed for low-risk classification (default 5). */
  maxLowRiskFiles?: number;
  /** Max changed lines (additions + deletions) for low-risk classification (default 150). */
  maxLowRiskLines?: number;
  /** Clock override (tests). */
  now?: number;
  /** Open PR inactivity threshold ms before flagging stale (default 48h). */
  staleAfterMs?: number;
  /** If true, `text` is "" when there is nothing actionable to report. */
  quietWhenClean?: boolean;
  /** Available backends passed through to capability routing suggestions. */
  availableBackends?: readonly DispatchBackend[];
}

export type PrPatrolAction =
  | "fix-ci"
  | "resolve-conflicts"
  | "address-review"
  | "ready-to-merge"
  | "needs-review"
  | "running"
  | "stale";

export interface PrPatrolItem {
  number: number;
  repo?: string;
  title: string;
  url?: string;
  headRefName?: string;
  checks: "passing" | "failing" | "pending" | "none";
  reviewDecision: string;
  hasConflict: boolean;
  action: PrPatrolAction;
  lowRisk: boolean;
  lowRiskReasons: string[];
  autoMergeEligible: boolean;
  suggestedDispatch?: {
    agent: DispatchBackend;
    task: string;
    rationale: string;
  };
  evidenceStatus?: "verified-done" | "incomplete";
  line: string;
}

export interface PrPatrolPreset {
  id: "pr-patrol";
  name: string;
  schedule: string;
  description: string;
  buildInstruction: (repos?: readonly string[]) => string;
}

export const PR_PATROL_PRESET: PrPatrolPreset = Object.freeze({
  id: "pr-patrol",
  name: "W7 PR Patrol",
  schedule: "every:30m",
  description:
    "Inspect open PRs for CI failures, merge conflicts, review feedback, and low-risk authorized auto-merge candidates; stay silent when all PRs are clean.",
  buildInstruction(repos?: readonly string[]): string {
    const scope =
      repos && repos.length > 0 ? `for repositories: ${repos.join(", ")}` : "across open PRs";
    return (
      `Run PR patrol ${scope}. Check CI rollups, merge conflicts, and review decisions; ` +
      `summarize actionable PRs with suggested fix dispatches, verify completion evidence ` +
      `(testPassed, screenshotPath, prUrl) before marking tasks verified-done, and stay ` +
      `silent if nothing needs attention.`
    );
  },
});

export interface PrPatrolSummary {
  totalOpen: number;
  actionableCount: number;
  failingCi: PrPatrolItem[];
  conflicts: PrPatrolItem[];
  changesRequested: PrPatrolItem[];
  readyToMerge: PrPatrolItem[];
  autoMergeCandidates: PrPatrolItem[];
  needsReview: PrPatrolItem[];
  pending: PrPatrolItem[];
  stale: PrPatrolItem[];
  items: PrPatrolItem[];
  /** True when nothing actionable requires human/agent intervention. */
  silent: boolean;
  headline: string;
  text: string;
  preset: PrPatrolPreset;
}

const DEFAULT_MAX_LOW_RISK_FILES = 5;
const DEFAULT_MAX_LOW_RISK_LINES = 150;
const DEFAULT_STALE_AFTER_MS = 48 * 60 * 60_000;
const SENSITIVE_PATH_RE =
  /(^|\/)(\.github\/workflows|auth|billing|warden|security|migrations?|secrets?|package(?:-lock)?\.json)/i;
const BLOCKING_LABEL_RE = /^(breaking|high[- ]risk|security|do[- ]not[- ]merge|hold|wip)$/i;

function labelName(raw: { name?: string } | string): string {
  return typeof raw === "string" ? raw : (raw.name ?? "");
}

/** Fail-closed low-risk classifier for PR auto-merge eligibility. Pure. */
export function classifyPrRisk(
  pr: PatrolPrInput,
  opts: Pick<PrPatrolOptions, "maxLowRiskFiles" | "maxLowRiskLines"> = {},
): { lowRisk: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const maxFiles = opts.maxLowRiskFiles ?? DEFAULT_MAX_LOW_RISK_FILES;
  const maxLines = opts.maxLowRiskLines ?? DEFAULT_MAX_LOW_RISK_LINES;

  if (pr.isDraft) reasons.push("PR is a draft");
  const checks = classifyChecks(pr.statusCheckRollup);
  if (checks !== "passing") reasons.push(`checks are ${checks}, not passing`);

  const conflict =
    (pr.mergeable ?? "").toUpperCase() === "CONFLICTING" ||
    (pr.mergeStateStatus ?? "").toUpperCase() === "DIRTY";
  if (conflict) reasons.push("PR has merge conflicts");

  const review = (pr.reviewDecision ?? "").toUpperCase();
  if (review !== "APPROVED") reasons.push(`review is ${review || "unapproved"}`);

  const fileCount =
    typeof pr.changedFiles === "number"
      ? pr.changedFiles
      : Array.isArray(pr.files)
        ? pr.files.length
        : null;
  if (fileCount === null) {
    reasons.push("changed file count unknown");
  } else if (fileCount > maxFiles) {
    reasons.push(`touches ${fileCount} files (> ${maxFiles})`);
  }

  const hasLineCounts = typeof pr.additions === "number" && typeof pr.deletions === "number";
  if (!hasLineCounts) {
    reasons.push("diff line count unknown");
  } else {
    const totalLines = (pr.additions ?? 0) + (pr.deletions ?? 0);
    if (totalLines > maxLines) {
      reasons.push(`changes ${totalLines} lines (> ${maxLines})`);
    }
  }

  if (Array.isArray(pr.files)) {
    const sensitive = pr.files.map((f) => f.path ?? "").find((p) => p && SENSITIVE_PATH_RE.test(p));
    if (sensitive) reasons.push(`touches sensitive path (${sensitive})`);
  }

  if (Array.isArray(pr.labels)) {
    const blocker = pr.labels.map(labelName).find((l) => BLOCKING_LABEL_RE.test(l.trim()));
    if (blocker) reasons.push(`has blocking label (${blocker})`);
  }

  return { lowRisk: reasons.length === 0, reasons };
}

const ACTION_PRIORITY: Record<PrPatrolAction, number> = {
  "fix-ci": 0,
  "resolve-conflicts": 1,
  "address-review": 2,
  stale: 3,
  "ready-to-merge": 4,
  "needs-review": 5,
  running: 6,
};

function suggestFix(
  action: "fix-ci" | "resolve-conflicts" | "address-review",
  pr: PatrolPrInput,
  available?: readonly DispatchBackend[],
): { agent: DispatchBackend; task: string; rationale: string } | undefined {
  const ref = pr.headRefName ? ` (branch ${pr.headRefName})` : "";
  const task =
    action === "fix-ci"
      ? `Fix failing CI checks and tests on PR #${pr.number}${ref}: ${pr.title ?? ""}`.trim()
      : action === "resolve-conflicts"
        ? `Resolve git merge conflicts on PR #${pr.number}${ref}: ${pr.title ?? ""}`.trim()
        : `Address review comments and refactor PR #${pr.number}${ref}: ${pr.title ?? ""}`.trim();

  const rec = recommendAgentForTask(task, available);
  if (!rec.recommended) return undefined;
  return { agent: rec.recommended, task, rationale: rec.rationale };
}

/**
 * Summarize open PR health for W7 PR patrol. Pure & deterministic.
 */
export function buildPrPatrolSummary(
  prs: readonly PatrolPrInput[],
  opts: PrPatrolOptions = {},
): PrPatrolSummary {
  const now = opts.now ?? Date.now();
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const authorizedRepos = new Set(opts.autoMergeRepos ?? []);

  const openPrs = prs.filter((p) => {
    const st = (p.state ?? "OPEN").toUpperCase();
    return st === "OPEN";
  });

  const items: PrPatrolItem[] = openPrs.map((pr) => {
    const repo = pr.repoFullName ?? pr.repository?.nameWithOwner ?? undefined;
    const title = (pr.title ?? "").trim() || `PR #${pr.number}`;
    const checks = classifyChecks(pr.statusCheckRollup);
    const review = (pr.reviewDecision ?? "").toUpperCase();
    const hasConflict =
      (pr.mergeable ?? "").toUpperCase() === "CONFLICTING" ||
      (pr.mergeStateStatus ?? "").toUpperCase() === "DIRTY";
    const updatedMs = pr.updatedAt ? Date.parse(pr.updatedAt) : Number.NaN;
    const isStale = Number.isFinite(updatedMs) && now - updatedMs > staleAfterMs;

    const risk = classifyPrRisk(pr, opts);
    const repoAuthorized =
      opts.autoMergeAuthorized === true || (repo !== undefined && authorizedRepos.has(repo));

    let action: PrPatrolAction;
    if (checks === "failing") action = "fix-ci";
    else if (hasConflict) action = "resolve-conflicts";
    else if (review === "CHANGES_REQUESTED") action = "address-review";
    else if (!pr.isDraft && checks === "passing" && review === "APPROVED")
      action = "ready-to-merge";
    else if (isStale) action = "stale";
    else if (pr.isDraft || checks === "pending") action = "running";
    else action = "needs-review";

    const autoMergeEligible = action === "ready-to-merge" && repoAuthorized && risk.lowRisk;

    const suggestedDispatch =
      action === "fix-ci" || action === "resolve-conflicts" || action === "address-review"
        ? suggestFix(action, pr, opts.availableBackends)
        : undefined;

    const evidenceStatus = pr.evidence ? verifyCompletionEvidence(pr.evidence).status : undefined;

    const tag =
      action === "fix-ci"
        ? "✗ CI failing"
        : action === "resolve-conflicts"
          ? "⚠ merge conflict"
          : action === "address-review"
            ? "💬 changes requested"
            : action === "ready-to-merge"
              ? autoMergeEligible
                ? "✓ ready (low-risk auto-merge eligible)"
                : "✓ approved — ready to merge"
              : action === "stale"
                ? "⏱ stale"
                : action === "running"
                  ? "⏳ running"
                  : "• awaiting review";

    const prefix = repo ? `${repo}#${pr.number}` : `#${pr.number}`;
    const dispatchNote = suggestedDispatch ? ` → suggest ${suggestedDispatch.agent}` : "";
    const line = `${prefix} ${tag} · ${title}${dispatchNote}`;

    return {
      number: pr.number,
      repo,
      title,
      url: pr.url,
      headRefName: pr.headRefName,
      checks,
      reviewDecision: review || "NONE",
      hasConflict,
      action,
      lowRisk: risk.lowRisk,
      lowRiskReasons: risk.reasons,
      autoMergeEligible,
      suggestedDispatch,
      evidenceStatus,
      line,
    };
  });

  items.sort(
    (a, b) => ACTION_PRIORITY[a.action] - ACTION_PRIORITY[b.action] || a.number - b.number,
  );

  const failingCi = items.filter((i) => i.action === "fix-ci");
  const conflicts = items.filter((i) => i.action === "resolve-conflicts");
  const changesRequested = items.filter((i) => i.action === "address-review");
  const readyToMerge = items.filter((i) => i.action === "ready-to-merge");
  const autoMergeCandidates = readyToMerge.filter((i) => i.autoMergeEligible);
  const needsReview = items.filter((i) => i.action === "needs-review");
  const pending = items.filter((i) => i.action === "running");
  const stale = items.filter((i) => i.action === "stale");

  const actionableCount =
    failingCi.length +
    conflicts.length +
    changesRequested.length +
    stale.length +
    autoMergeCandidates.length;
  const silent = actionableCount === 0;

  const summaryBits: string[] = [];
  if (failingCi.length) summaryBits.push(`${failingCi.length} failing CI`);
  if (conflicts.length) summaryBits.push(`${conflicts.length} conflict(s)`);
  if (changesRequested.length) summaryBits.push(`${changesRequested.length} changes requested`);
  if (stale.length) summaryBits.push(`${stale.length} stale`);
  if (autoMergeCandidates.length)
    summaryBits.push(`${autoMergeCandidates.length} auto-merge eligible`);
  if (readyToMerge.length > autoMergeCandidates.length) {
    summaryBits.push(`${readyToMerge.length - autoMergeCandidates.length} ready to merge`);
  }
  if (needsReview.length) summaryBits.push(`${needsReview.length} awaiting review`);
  if (pending.length) summaryBits.push(`${pending.length} running`);

  const headline =
    openPrs.length === 0
      ? "PR patrol: no open PRs."
      : `PR patrol (${openPrs.length} open): ${summaryBits.join(", ")}.`;

  const text =
    silent && opts.quietWhenClean
      ? ""
      : openPrs.length === 0
        ? headline
        : [headline, ...items.map((i) => `  ${i.line}`)].join("\n");

  return {
    totalOpen: openPrs.length,
    actionableCount,
    failingCi,
    conflicts,
    changesRequested,
    readyToMerge,
    autoMergeCandidates,
    needsReview,
    pending,
    stale,
    items,
    silent,
    headline,
    text,
    preset: PR_PATROL_PRESET,
  };
}
