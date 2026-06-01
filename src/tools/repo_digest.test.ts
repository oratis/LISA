import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatDigest, type RepoDigest } from "./repo_digest.js";

function d(over: Partial<RepoDigest> = {}): RepoDigest {
  return {
    root: "/Users/x/repo",
    branch: "main",
    commits: [],
    dirtyFiles: 0,
    diffStat: "",
    ahead: 0,
    behind: 0,
    since: "1 day ago",
    ...over,
  };
}

describe("repo_digest formatDigest", () => {
  test("clean repo with no recent commits", () => {
    const out = formatDigest(d());
    assert.match(out, /▸ repo @ main/);
    assert.match(out, /no commits since 1 day ago/);
    assert.match(out, /working tree clean/);
  });

  test("lists commits and uncommitted changes", () => {
    const out = formatDigest(
      d({ commits: ["abc123 feat: x", "def456 fix: y"], dirtyFiles: 2, diffStat: "3 files changed, 10 insertions(+)" }),
    );
    assert.match(out, /commits since 1 day ago:/);
    assert.match(out, /abc123 feat: x/);
    assert.match(out, /uncommitted: 2 file\(s\) · 3 files changed/);
  });

  test("shows ahead/behind vs upstream", () => {
    const out = formatDigest(d({ ahead: 3, behind: 1 }));
    assert.match(out, /↑3↓1 vs upstream/);
  });

  test("error repos render a single line", () => {
    const out = formatDigest(d({ error: "not a git repo" }));
    assert.equal(out, "▸ repo — not a git repo");
  });
});
