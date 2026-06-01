import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseRemote, buildUrl, type Remote } from "./github_link.js";

describe("github_link parseRemote", () => {
  const cases: [string, Remote][] = [
    ["git@github.com:oratis/LISA.git", { host: "github.com", owner: "oratis", repo: "LISA" }],
    ["https://github.com/oratis/LISA.git", { host: "github.com", owner: "oratis", repo: "LISA" }],
    ["https://github.com/oratis/LISA", { host: "github.com", owner: "oratis", repo: "LISA" }],
    ["ssh://git@github.com/oratis/LISA.git", { host: "github.com", owner: "oratis", repo: "LISA" }],
    ["https://x@github.com/oratis/LISA.git", { host: "github.com", owner: "oratis", repo: "LISA" }],
    ["git@ghe.corp.com:team/app.git", { host: "ghe.corp.com", owner: "team", repo: "app" }],
  ];
  for (const [url, want] of cases) {
    test(`parses ${url}`, () => assert.deepEqual(parseRemote(url), want));
  }
  test("returns null for junk", () => {
    assert.equal(parseRemote("not a url"), null);
    assert.equal(parseRemote("https://github.com/onlyowner"), null);
  });
});

describe("github_link buildUrl", () => {
  const r: Remote = { host: "github.com", owner: "oratis", repo: "LISA" };
  test("repo", () => assert.equal(buildUrl(r, "repo"), "https://github.com/oratis/LISA"));
  test("branch", () => assert.equal(buildUrl(r, "branch", { ref: "feat/x" }), "https://github.com/oratis/LISA/tree/feat%2Fx"));
  test("commit", () => assert.equal(buildUrl(r, "commit", { ref: "abc123" }), "https://github.com/oratis/LISA/commit/abc123"));
  test("file with line range", () =>
    assert.equal(
      buildUrl(r, "file", { ref: "main", path: "src/web/server.ts", startLine: 10, endLine: 20 }),
      "https://github.com/oratis/LISA/blob/main/src/web/server.ts#L10-L20",
    ));
  test("file single line", () =>
    assert.equal(buildUrl(r, "file", { ref: "main", path: "a.ts", startLine: 5 }), "https://github.com/oratis/LISA/blob/main/a.ts#L5"));
  test("pr / issue", () => {
    assert.equal(buildUrl(r, "pr", { number: 58 }), "https://github.com/oratis/LISA/pull/58");
    assert.equal(buildUrl(r, "issue", { number: 3 }), "https://github.com/oratis/LISA/issues/3");
  });
  test("missing inputs error", () => {
    assert.ok(typeof buildUrl(r, "file", {}) === "object");
    assert.ok(typeof buildUrl(r, "pr", {}) === "object");
    assert.ok(typeof buildUrl(r, "commit", {}) === "object");
  });
});
