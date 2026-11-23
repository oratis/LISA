/** Pure GitHub PR check-rollup classifier shared by github-pr observer and PR patrol. */

export interface RawPrCheck {
  __typename?: string;
  status?: string | null; // CheckRun: QUEUED | IN_PROGRESS | COMPLETED
  conclusion?: string | null; // CheckRun: SUCCESS | FAILURE | …
  state?: string | null; // StatusContext: SUCCESS | PENDING | FAILURE | ERROR
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

const PENDING_STATUSES = new Set(["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"]);

/** Reduce a check rollup to one verdict. Pure. */
export function classifyChecks(
  rollup: RawPrCheck[] | null | undefined,
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
    if ((status && status !== "COMPLETED" && PENDING_STATUSES.has(status)) || state === "PENDING") {
      pending = true;
    }
  }
  return pending ? "pending" : "passing";
}
