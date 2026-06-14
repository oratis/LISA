import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseGitStatus, deriveGitState, gitActivity, findGitRepos } from "./observer.js";

describe("parseGitStatus", () => {
  test("extracts branch, ahead/behind, changed files, staged count", () => {
    const g = parseGitStatus(
      [
        "## main...origin/main [ahead 2, behind 1]",
        " M src/foo.ts",
        "?? new.txt",
        "A  staged.ts",
        "R  old.ts -> renamed.ts",
      ].join("\n"),
    );
    assert.equal(g.branch, "main");
    assert.equal(g.ahead, 2);
    assert.equal(g.behind, 1);
    assert.deepEqual(g.changedFiles, ["src/foo.ts", "new.txt", "staged.ts", "renamed.ts"]);
    assert.equal(g.staged, 2); // the A and R entries
  });

  test("clean repo → no files, ahead 0", () => {
    const g = parseGitStatus("## main...origin/main");
    assert.equal(g.branch, "main");
    assert.equal(g.ahead, 0);
    assert.deepEqual(g.changedFiles, []);
  });

  test("branch names with dots are kept whole (split on '...', not '.')", () => {
    assert.equal(parseGitStatus("## feat/v2.0...origin/feat/v2.0 [ahead 1]").branch, "feat/v2.0");
  });

  test("detached HEAD → null branch", () => {
    assert.equal(parseGitStatus("## HEAD (no branch)").branch, null);
  });

  test("a fresh repo with no commits still reports its branch", () => {
    assert.equal(parseGitStatus("## No commits yet on main").branch, "main");
  });
});

describe("deriveGitState", () => {
  const base = { branch: "main", ahead: 0, behind: 0, changedFiles: [], staged: 0 };
  test("uncommitted changes → working", () => {
    assert.deepEqual(deriveGitState({ ...base, changedFiles: ["a.ts", "b.ts"] }), {
      state: "working",
      reason: "2 uncommitted",
    });
  });
  test("clean but ahead → waiting", () => {
    assert.deepEqual(deriveGitState({ ...base, ahead: 3 }), { state: "waiting", reason: "3 to push" });
  });
  test("clean and in sync → idle", () => {
    assert.deepEqual(deriveGitState(base), { state: "idle", reason: "clean" });
  });
  test("detached → unknown", () => {
    assert.deepEqual(deriveGitState({ ...base, branch: null }), { state: "unknown", reason: "detached" });
  });
});

describe("gitActivity (privacy: paths + branch only)", () => {
  test("surfaces branch + changed paths, never tool calls", () => {
    const a = gitActivity({ branch: "dev", ahead: 1, behind: 0, changedFiles: ["x.ts"], staged: 0 });
    assert.equal(a.gitBranch, "dev");
    assert.deepEqual(a.filesTouched, ["x.ts"]);
    assert.deepEqual(a.lastTools, []);
    assert.equal(a.turnCount, 1);
  });
});

describe("findGitRepos", () => {
  test("finds repos, stops at a repo boundary, skips node_modules", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-git-"));
    fs.mkdirSync(path.join(tmp, "repoA", ".git"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "repoA", "nested", ".git"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "sub", "repoB", ".git"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "node_modules", "pkg", ".git"), { recursive: true });

    const found = (await findGitRepos(tmp)).map((p) => path.relative(tmp, p)).sort();
    assert.deepEqual(found, ["repoA", path.join("sub", "repoB")]);
    // nested repo under repoA isn't found (we don't descend into a repo);
    // node_modules is skipped.
  });
});
