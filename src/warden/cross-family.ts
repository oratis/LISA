/**
 * Optional monotonic cross-family review gate for Warden.
 *
 * When configured, a secondary reviewer from a DIFFERENT model provider family
 * than the execution model can inspect side-effecting tool calls that Warden's
 * base policy would otherwise allow.
 *
 * Security invariants:
 *  1. Monotonic only: can ONLY tighten `"allow"` → `"ask"` or `"deny"`. It is
 *     never invoked on `"ask"`, `"deny"`, or `"handoff"`, and can never loosen
 *     a stricter base verdict.
 *  2. Distinct provider family: if the reviewer's family matches the execution
 *     model's family (or either family cannot be distinguished when unknown),
 *     the gate fails closed to `"ask"` rather than silently providing
 *     same-family theater.
 *  3. Fail-closed on timeout, thrown errors, or malformed verdicts: converts
 *     `"allow"` → `"ask"`.
 */
import type { ActionRequest } from "./types.js";

export type ProviderFamily = "anthropic" | "openai" | "google" | "deepseek" | "other";

export type CrossFamilyDecision =
  | { verdict: "allow"; reason?: string }
  | { verdict: "ask"; reason: string }
  | { verdict: "deny"; reason: string };

export interface CrossFamilyReviewer {
  /** Reviewer model identifier (used to enforce distinct provider family). */
  model: string;
  /** Evaluate a redacted ActionRequest; may never return a looser verdict than allow. */
  review(req: ActionRequest, signal?: AbortSignal): Promise<CrossFamilyDecision>;
}

export interface CrossFamilyGateOptions {
  /** Model executing the primary agent turn. */
  executionModel: string;
  reviewer: CrossFamilyReviewer;
  /** Timeout before failing closed to `"ask"`. Default: 8 seconds. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CrossFamilyGateResult {
  verdict: "allow" | "ask" | "deny";
  reason: string;
  ruleId: string;
  executionFamily: ProviderFamily;
  reviewerFamily: ProviderFamily;
}

const DEFAULT_REVIEW_TIMEOUT_MS = 8_000;

/** Deterministic provider-family classification for cross-family separation. */
export function modelProviderFamily(model: string): ProviderFamily {
  const lower = String(model ?? "")
    .trim()
    .toLowerCase();
  if (!lower) return "other";
  if (lower.includes("claude") || lower.startsWith("anthropic/")) return "anthropic";
  if (
    lower.includes("gemini") ||
    lower.startsWith("google/") ||
    lower.startsWith("models/gemini")
  ) {
    return "google";
  }
  if (
    lower.startsWith("gpt-") ||
    lower.startsWith("openai/") ||
    lower.startsWith("chatgpt") ||
    /^o[1-9](?:[-.]|$)/.test(lower)
  ) {
    return "openai";
  }
  if (lower.includes("deepseek")) return "deepseek";
  return "other";
}

function isDistinctFamily(execFamily: ProviderFamily, reviewFamily: ProviderFamily): boolean {
  if (execFamily === "other" || reviewFamily === "other") return false;
  return execFamily !== reviewFamily;
}

/**
 * Run a monotonic cross-family review over an already-redacted ActionRequest.
 * Never throws; every failure mode tightens to `"ask"`.
 */
export async function runCrossFamilyReview(
  req: ActionRequest,
  opts: CrossFamilyGateOptions,
): Promise<CrossFamilyGateResult> {
  const executionFamily = modelProviderFamily(opts.executionModel);
  const reviewerFamily = modelProviderFamily(opts.reviewer.model);

  if (!isDistinctFamily(executionFamily, reviewerFamily)) {
    return {
      verdict: "ask",
      reason: `Cross-family review requires a distinct model family (execution=${executionFamily}, reviewer=${reviewerFamily}); asking instead.`,
      ruleId: "system:cross-family-same-family",
      executionFamily,
      reviewerFamily,
    };
  }

  const timeoutMs = Math.max(50, opts.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS);
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await Promise.race<CrossFamilyDecision>([
      opts.reviewer.review(req, controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new Error(timedOut ? "review timed out" : "review aborted")),
          { once: true },
        );
      }),
    ]);

    if (!response || typeof response !== "object") {
      return {
        verdict: "ask",
        reason: "Cross-family reviewer returned an invalid response; asking instead.",
        ruleId: "system:cross-family-error",
        executionFamily,
        reviewerFamily,
      };
    }

    if (response.verdict === "allow") {
      return {
        verdict: "allow",
        reason: response.reason?.trim() || "Cross-family review passed.",
        ruleId: "system:cross-family-review",
        executionFamily,
        reviewerFamily,
      };
    }
    if (response.verdict === "ask") {
      return {
        verdict: "ask",
        reason:
          typeof response.reason === "string" && response.reason.trim()
            ? response.reason.trim()
            : "Cross-family reviewer requested confirmation for this action.",
        ruleId: "system:cross-family-review",
        executionFamily,
        reviewerFamily,
      };
    }
    if (response.verdict === "deny") {
      return {
        verdict: "deny",
        reason:
          typeof response.reason === "string" && response.reason.trim()
            ? response.reason.trim()
            : "Cross-family reviewer blocked this action.",
        ruleId: "system:cross-family-review",
        executionFamily,
        reviewerFamily,
      };
    }

    return {
      verdict: "ask",
      reason: "Cross-family reviewer returned an unknown verdict; asking instead.",
      ruleId: "system:cross-family-error",
      executionFamily,
      reviewerFamily,
    };
  } catch (err) {
    return {
      verdict: "ask",
      reason: timedOut
        ? "Cross-family review timed out; asking instead."
        : `Cross-family review failed (${(err as Error).message}); asking instead.`,
      ruleId: timedOut ? "system:cross-family-timeout" : "system:cross-family-error",
      executionFamily,
      reviewerFamily,
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onParentAbort);
  }
}
