import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { summarizeChecks, formatPR } from "./pr_status.js";

describe("pr_status summarizeChecks", () => {
  test("no checks → –", () => assert.equal(summarizeChecks([]), "–"));
  test("all success → ✓", () =>
    assert.equal(summarizeChecks([{ conclusion: "SUCCESS" }, { state: "SUCCESS" }]), "✓"));
  test("any failure → ✗ (even amid successes)", () =>
    assert.equal(summarizeChecks([{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }]), "✗"));
  test("pending (no fail) → ⏳", () =>
    assert.equal(summarizeChecks([{ conclusion: "SUCCESS" }, { status: "IN_PROGRESS", conclusion: null }]), "⏳"));
  test("failure dominates pending", () =>
    assert.equal(summarizeChecks([{ status: "IN_PROGRESS" }, { state: "ERROR" }]), "✗"));
});

describe("pr_status formatPR", () => {
  test("renders number, CI, review, title, branch", () => {
    const line = formatPR({
      number: 42,
      title: "feat: add thing",
      headRefName: "feat/thing",
      isDraft: false,
      reviewDecision: "APPROVED",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    });
    assert.match(line, /#42 ✓ CI · approved · feat: add thing  \[feat\/thing\]/);
  });
  test("marks drafts and changes-requested", () => {
    const line = formatPR({
      number: 7, title: "wip", headRefName: "wip", isDraft: true,
      reviewDecision: "CHANGES_REQUESTED", statusCheckRollup: [{ conclusion: "FAILURE" }],
    });
    assert.match(line, /#7 ✗ CI · changes requested · wip \(draft\)/);
  });
});
