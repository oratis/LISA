import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildGhArgs } from "./github.js";

describe("github buildGhArgs", () => {
  test("issue_list uses --json and state", () => {
    const r = buildGhArgs({ action: "issue_list", state: "all" }) as { args: string[] };
    assert.deepEqual(r.args.slice(0, 4), ["issue", "list", "--state", "all"]);
    assert.ok(r.args.includes("--json"));
  });

  test("issue_create needs a title", () => {
    assert.ok("error" in buildGhArgs({ action: "issue_create" }));
    const r = buildGhArgs({ action: "issue_create", title: "bug", body: "details" }) as { args: string[] };
    assert.deepEqual(r.args, ["issue", "create", "--title", "bug", "--body", "details"]);
  });

  test("issue_comment needs number + body", () => {
    assert.ok("error" in buildGhArgs({ action: "issue_comment", number: 1 }));
    const r = buildGhArgs({ action: "issue_comment", number: 7, body: "ack" }) as { args: string[] };
    assert.deepEqual(r.args, ["issue", "comment", "7", "--body", "ack"]);
  });

  test("pr_create passes base when given", () => {
    const r = buildGhArgs({ action: "pr_create", title: "feat", body: "b", base: "main" }) as { args: string[] };
    assert.deepEqual(r.args, ["pr", "create", "--title", "feat", "--body", "b", "--base", "main"]);
  });

  test("pr_merge defaults to squash + delete-branch", () => {
    const r = buildGhArgs({ action: "pr_merge", number: 12 }) as { args: string[] };
    assert.deepEqual(r.args, ["pr", "merge", "12", "--squash", "--delete-branch"]);
    const rebase = buildGhArgs({ action: "pr_merge", number: 12, merge_method: "rebase" }) as { args: string[] };
    assert.ok(rebase.args.includes("--rebase"));
  });

  test("run_view needs an id", () => {
    assert.ok("error" in buildGhArgs({ action: "run_view" }));
    const r = buildGhArgs({ action: "run_view", number: 123 }) as { args: string[] };
    assert.deepEqual(r.args, ["run", "view", "123"]);
  });

  test("task strings are passed as separate argv (no shell interpolation)", () => {
    const r = buildGhArgs({ action: "issue_create", title: "a; rm -rf /", body: "$(whoami)" }) as { args: string[] };
    // The dangerous strings are discrete args, never concatenated into a command.
    assert.ok(r.args.includes("a; rm -rf /"));
    assert.ok(r.args.includes("$(whoami)"));
  });
});
