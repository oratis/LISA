import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cwdGitBranch, _clearCwdBranchCache } from "./branch.js";

const pexec = promisify(execFile);

// One real-git integration test for the resolver itself; observers inject a
// fake resolver (see their tests), so this is the only place real git runs.
describe("cwdGitBranch (real git)", () => {
  let dir: string;
  beforeEach(async () => {
    _clearCwdBranchCache();
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "lisa-branch-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("a git repo → a non-empty branch name", async () => {
    const repo = path.join(dir, "repo");
    await fsp.mkdir(repo);
    await pexec("git", ["-C", repo, "init"]);
    const branch = await cwdGitBranch(repo);
    assert.equal(typeof branch, "string");
    assert.ok((branch as string).length > 0, `expected a branch name, got ${branch}`);
  });

  test("a non-repo directory → undefined", async () => {
    const plain = path.join(dir, "plain");
    await fsp.mkdir(plain);
    assert.equal(await cwdGitBranch(plain), undefined);
  });

  test("undefined cwd → undefined (no spawn)", async () => {
    assert.equal(await cwdGitBranch(undefined), undefined);
  });

  test("caches within the TTL (second call doesn't see a moved branch)", async () => {
    const repo = path.join(dir, "cached");
    await fsp.mkdir(repo);
    await pexec("git", ["-C", repo, "init"]);
    const t0 = 1_000_000;
    const first = await cwdGitBranch(repo, t0);
    // Switch branch on disk, but query again inside the TTL → cached value.
    await pexec("git", ["-C", repo, "checkout", "-b", "another-branch"]);
    const cached = await cwdGitBranch(repo, t0 + 1_000);
    assert.equal(cached, first);
    // Past the TTL → re-resolves to the new branch.
    const fresh = await cwdGitBranch(repo, t0 + 60_000);
    assert.equal(fresh, "another-branch");
  });
});
