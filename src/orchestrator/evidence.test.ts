import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertCompletionEvidence,
  buildPrPatrolSummary,
  canMarkVerifiedDone,
  classifyPrRisk,
  isValidPrUrl,
  isValidScreenshotPath,
  PR_PATROL_PRESET,
  verifyCompletionEvidence,
  type PatrolPrInput,
} from "./evidence.js";

describe("completion evidence verification", () => {
  test("passes only when testPassed, screenshotPath, and prUrl are all valid", () => {
    const res = verifyCompletionEvidence({
      testPassed: true,
      testCommand: "npm test",
      screenshotPath: "/tmp/evidence/ui.png",
      prUrl: "https://github.com/oratis/LISA/pull/540",
    });
    assert.equal(res.verified, true);
    assert.equal(res.status, "verified-done");
    assert.deepEqual(res.missing, []);
    assert.deepEqual(res.errors, []);
    assert.equal(
      canMarkVerifiedDone({
        testPassed: true,
        screenshotPath: "artifacts/screen.png",
        prUrl: "https://github.com/oratis/LISA/pull/540",
      }),
      true,
    );
  });

  test("rejects missing or failing testPassed, missing screenshotPath, and invalid prUrl", () => {
    const empty = verifyCompletionEvidence({});
    assert.equal(empty.verified, false);
    assert.equal(empty.status, "incomplete");
    assert.deepEqual(empty.missing, ["testPassed", "screenshotPath", "prUrl"]);

    const failedTests = verifyCompletionEvidence({
      testPassed: false,
      screenshotPath: "/tmp/shot.png",
      prUrl: "https://github.com/oratis/LISA/pull/1",
    });
    assert.equal(failedTests.verified, false);
    assert.deepEqual(failedTests.missing, ["testPassed"]);
    assert.match(failedTests.summary, /tests failed/);

    for (const badUrl of [
      "http://github.com/oratis/LISA/pull/1",
      "https://user:pass@github.com/oratis/LISA/pull/1",
      "https://github.com/oratis/LISA/issues/1",
      "javascript:alert(1)",
      "not-a-url",
    ]) {
      assert.equal(isValidPrUrl(badUrl), false, badUrl);
    }
    for (const badShot of ["", "   ", "-rf", "https://example.com/a.png", "a\0b.png", ".."]) {
      assert.equal(isValidScreenshotPath(badShot), false, badShot);
    }

    assert.throws(
      () =>
        assertCompletionEvidence({
          testPassed: true,
          prUrl: "https://github.com/oratis/LISA/pull/2",
        }),
      /Cannot mark task verified-done: incomplete \(screenshotPath\)/,
    );
  });

  test("policy overrides allow skipping screenshot for backend tasks and verify screenshot on disk", () => {
    const backendOk = verifyCompletionEvidence(
      { testPassed: true, prUrl: "https://github.com/oratis/LISA/pull/99" },
      { requireScreenshot: false },
    );
    assert.equal(backendOk.verified, true);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-ev-"));
    try {
      const emptyShot = path.join(tmp, "empty.png");
      fs.writeFileSync(emptyShot, "");
      const emptyCheck = verifyCompletionEvidence(
        {
          testPassed: true,
          screenshotPath: emptyShot,
          prUrl: "https://github.com/oratis/LISA/pull/99",
        },
        { verifyScreenshotOnDisk: true },
      );
      assert.equal(emptyCheck.verified, false);
      assert.match(emptyCheck.summary, /missing or empty on disk/);

      const realShot = path.join(tmp, "real.png");
      fs.writeFileSync(realShot, "PNGDATA");
      const okCheck = verifyCompletionEvidence(
        {
          testPassed: true,
          screenshotPath: realShot,
          prUrl: "https://github.com/oratis/LISA/pull/99",
        },
        { verifyScreenshotOnDisk: true },
      );
      assert.equal(okCheck.verified, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("W7 PR patrol — buildPrPatrolSummary & auto-merge risk gate", () => {
  const NOW = Date.parse("2026-11-24T00:00:00Z");

  const basePr = (over: Partial<PatrolPrInput> = {}): PatrolPrInput => ({
    number: 10,
    title: "polish docs",
    repoFullName: "oratis/LISA",
    headRefName: "feat/polish",
    state: "OPEN",
    isDraft: false,
    updatedAt: "2026-11-23T23:00:00Z",
    reviewDecision: "APPROVED",
    mergeable: "MERGEABLE",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
    changedFiles: 1,
    additions: 20,
    deletions: 10,
    files: [{ path: "docs/GUIDE.md" }],
    labels: [],
    ...over,
  });

  test("classifies failing CI, merge conflicts, changes requested, and suggests agents", () => {
    const summary = buildPrPatrolSummary(
      [
        basePr({
          number: 1,
          title: "fix auth tests",
          reviewDecision: "REVIEW_REQUIRED",
          statusCheckRollup: [{ conclusion: "FAILURE" }],
        }),
        basePr({
          number: 2,
          title: "rebase branch",
          mergeable: "CONFLICTING",
          reviewDecision: "REVIEW_REQUIRED",
        }),
        basePr({
          number: 3,
          title: "refactor router",
          reviewDecision: "CHANGES_REQUESTED",
        }),
      ],
      { now: NOW },
    );

    assert.equal(summary.totalOpen, 3);
    assert.equal(summary.failingCi.length, 1);
    assert.equal(summary.conflicts.length, 1);
    assert.equal(summary.changesRequested.length, 1);
    assert.equal(summary.silent, false);
    assert.equal(summary.actionableCount, 3);
    assert.ok(summary.failingCi[0]!.suggestedDispatch?.agent);
    assert.ok(summary.conflicts[0]!.suggestedDispatch?.agent);
    assert.ok(summary.changesRequested[0]!.suggestedDispatch?.agent);
    assert.equal(summary.preset.id, PR_PATROL_PRESET.id);
    assert.match(PR_PATROL_PRESET.buildInstruction(["oratis/LISA"]), /PR patrol/);
  });

  test("auto-merge eligibility requires BOTH explicit repo authorization AND low-risk classification", () => {
    const lowRiskPr = basePr({ number: 20 });

    // Low-risk but repo NOT authorized → not auto-merge eligible.
    const unauthorized = buildPrPatrolSummary([lowRiskPr], { now: NOW });
    assert.equal(unauthorized.readyToMerge.length, 1);
    assert.equal(unauthorized.autoMergeCandidates.length, 0);

    // Authorized AND low-risk → auto-merge eligible.
    const authorized = buildPrPatrolSummary([lowRiskPr], {
      now: NOW,
      autoMergeRepos: ["oratis/LISA"],
    });
    assert.equal(authorized.autoMergeCandidates.length, 1);
    assert.equal(authorized.silent, false);

    // Authorized BUT touches sensitive path (src/warden/policy.ts) → NOT low-risk.
    const sensitiveRisk = classifyPrRisk(basePr({ files: [{ path: "src/warden/policy.ts" }] }));
    assert.equal(sensitiveRisk.lowRisk, false);
    assert.match(sensitiveRisk.reasons.join("; "), /sensitive path/);

    // Authorized BUT missing diff size metrics → fails closed (NOT low-risk).
    const unknownMetrics = classifyPrRisk(
      basePr({
        changedFiles: undefined,
        files: undefined,
        additions: undefined,
        deletions: undefined,
      }),
    );
    assert.equal(unknownMetrics.lowRisk, false);

    // Omitted or truncated `files` list → fails closed so sensitive-path check cannot be bypassed.
    const omittedFiles = classifyPrRisk(basePr({ files: undefined }));
    assert.equal(omittedFiles.lowRisk, false);
    assert.match(omittedFiles.reasons.join("; "), /changed file list unknown/);

    const truncatedFiles = classifyPrRisk(
      basePr({ changedFiles: 2, files: [{ path: "docs/GUIDE.md" }] }),
    );
    assert.equal(truncatedFiles.lowRisk, false);
    assert.match(truncatedFiles.reasons.join("; "), /changed file list incomplete/);

    // Authorized BUT too many lines or blocking label → NOT low-risk.
    assert.equal(classifyPrRisk(basePr({ additions: 200, deletions: 10 })).lowRisk, false);
    assert.equal(classifyPrRisk(basePr({ labels: [{ name: "security" }] })).lowRisk, false);
  });

  test("stays silent when PRs are clean/running and no auto-merge is authorized", () => {
    const summary = buildPrPatrolSummary(
      [
        basePr({
          number: 30,
          reviewDecision: "REVIEW_REQUIRED",
          statusCheckRollup: [{ status: "IN_PROGRESS" }],
        }),
        basePr({ number: 31, reviewDecision: "APPROVED" }), // not auto-merge authorized
      ],
      { now: NOW, quietWhenClean: true },
    );
    assert.equal(summary.silent, true);
    assert.equal(summary.actionableCount, 0);
    assert.equal(summary.text, "");
  });
});
