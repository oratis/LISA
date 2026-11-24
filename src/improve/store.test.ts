import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import {
  applyImprovement,
  createImprovement,
  exportContribution,
  listImprovements,
  previewImprovement,
  rollbackImprovement,
} from "./store.js";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lisa-improve-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function makeHome(name: string): string {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("Improve LISA M0/M1 personal capability store", () => {
  test("isolates two homes with same-named capabilities and binds apply to preview digest", async () => {
    const homeA = makeHome("user-a");
    const homeB = makeHome("user-b");

    const impA = await createImprovement(
      {
        title: "Weekly Digest",
        packageId: "weekly-digest",
        goal: "Format weekly summary cleanly",
        files: [{ path: "SKILL.md", content: "# User A Weekly Digest\n" }],
      },
      homeA,
    );
    const impB = await createImprovement(
      {
        title: "Weekly Digest",
        packageId: "weekly-digest",
        goal: "Different format for User B",
        files: [{ path: "SKILL.md", content: "# User B Weekly Digest\n" }],
      },
      homeB,
    );

    const prevA = await previewImprovement(impA.id, {}, homeA);
    assert.equal(prevA.workStatus, "preview_ready");
    const oldDigest = prevA.changeSet!.digest;

    // Editing file rotates digest so old approval cannot cover modified content.
    const prevA2 = await previewImprovement(
      impA.id,
      { files: [{ path: "SKILL.md", content: "# User A Weekly Digest v2\n" }] },
      homeA,
    );
    assert.notEqual(prevA2.changeSet!.digest, oldDigest);

    const staleApply = await applyImprovement(impA.id, oldDigest, homeA);
    assert.equal(staleApply.ok, false);
    if (!staleApply.ok) assert.equal(staleApply.error, "digest_mismatch");

    const appliedA = await applyImprovement(impA.id, prevA2.changeSet!.digest, homeA);
    assert.equal(appliedA.ok, true);
    if (appliedA.ok) {
      assert.equal(appliedA.version.version, 1);
      assert.equal(appliedA.alreadyActive, false);
    }

    // Re-applying same digest is idempotent.
    const idempotent = await applyImprovement(impA.id, prevA2.changeSet!.digest, homeA);
    assert.equal(idempotent.ok, true);
    if (idempotent.ok) assert.equal(idempotent.alreadyActive, true);

    // Home B remains completely unaffected.
    const listB = await listImprovements(homeB);
    assert.equal(listB.activeCapabilities.length, 0);
    assert.equal(listB.items[0]!.id, impB.id);
  });

  test("detects concurrent baseProfileVersion conflicts and preserves sessions/memory on rollback", async () => {
    const home = makeHome("conflict-home");
    const memoryFile = path.join(home, "MEMORY.md");
    fs.writeFileSync(memoryFile, "Keep user memory intact.");

    const first = await createImprovement(
      { title: "First Cap", goal: "Add first skill", files: [{ path: "SKILL.md", content: "v1" }] },
      home,
    );
    const second = await createImprovement(
      {
        title: "Second Cap",
        goal: "Add second skill",
        files: [{ path: "SKILL.md", content: "v2" }],
      },
      home,
    );

    const p1 = await previewImprovement(first.id, {}, home);
    const p2 = await previewImprovement(second.id, {}, home);
    assert.equal((await applyImprovement(first.id, p1.changeSet!.digest, home)).ok, true);

    // Second was drafted against profileVersion 0; applying now must detect conflict.
    const conflict = await applyImprovement(second.id, p2.changeSet!.digest, home);
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.error, "upstream_conflict");

    // Re-previewing rebases to current profileVersion and succeeds.
    const p2Rebased = await previewImprovement(second.id, { rebaseToCurrentProfile: true }, home);
    assert.equal((await applyImprovement(second.id, p2Rebased.changeSet!.digest, home)).ok, true);

    // Rollback removes active capability without touching MEMORY.md.
    const rolled = await rollbackImprovement(first.id, home);
    assert.equal(rolled.activationStatus, "rolled_back");
    assert.equal(fs.readFileSync(memoryFile, "utf8"), "Keep user memory intact.");
  });

  test("de-privatizes community export, scrubs local home paths, and refuses secrets", async () => {
    const home = makeHome("export-home");
    const clean = await createImprovement(
      {
        title: "Clean Skill",
        packageId: "clean-skill",
        goal: "Reusable template",
        files: [{ path: "SKILL.md", content: "Example path: /Users/alice/projects/demo" }],
      },
      home,
    );
    await previewImprovement(clean.id, {}, home);
    const exported = await exportContribution(clean.id, home);
    assert.equal(exported.record.contributionStatus, "pr_ready");
    assert.ok(exported.contribution.exportDigest.length === 64);
    assert.ok(exported.contribution.compareUrl.includes("github.com/oratis/LISA/compare/main..."));
    const exportedFile = fs.readFileSync(
      path.join(home, "improvements", "exports", clean.id, "SKILL.md"),
      "utf8",
    );
    assert.ok(!exportedFile.includes("/Users/alice"));
    assert.ok(exportedFile.includes("/Users/example"));

    const secret = await createImprovement(
      {
        title: "Leaky Skill",
        goal: "Contains secret",
        files: [
          {
            path: "SKILL.md",
            content: "token=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          },
        ],
      },
      home,
    );
    const failedPreview = await previewImprovement(secret.id, {}, home);
    assert.equal(failedPreview.workStatus, "failed");
    await assert.rejects(() => exportContribution(secret.id, home), /secret-like/);
  });
});
