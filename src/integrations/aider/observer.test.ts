import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseAiderState, walkHistories, AiderObserver } from "./observer.js";

describe("parseAiderState — tolerant heuristic", () => {
  test("user turn with no reply yet → working", () => {
    const tail = "# aider chat started\n> info\n#### add a function\n";
    assert.deepEqual(parseAiderState(tail), { state: "working", reason: "user" });
  });

  test("assistant prose after the user turn → waiting", () => {
    const tail = "#### add a function\nSure, here is the change:\n```py\nx=1\n```\n";
    assert.equal(parseAiderState(tail).state, "waiting");
  });

  test("aider result line after the user turn → waiting", () => {
    const tail = "#### add a function\n> Applied edit to foo.py\n";
    assert.equal(parseAiderState(tail).state, "waiting");
  });

  test("error marker after the user turn → error (real litellm shape)", () => {
    const tail =
      "#### reply with exactly: ok\n" +
      '> litellm.NotFoundError: AnthropicException - {"type":"error"...}\n';
    assert.equal(parseAiderState(tail).state, "error");
  });

  test("no user turn → unknown", () => {
    assert.equal(parseAiderState("# aider chat started\n> just info\n").state, "unknown");
  });

  test("only the LAST turn decides (earlier reply doesn't mask a new prompt)", () => {
    const tail =
      "#### first\nassistant replied here\n> Applied edit\n#### second question\n";
    assert.deepEqual(parseAiderState(tail), { state: "working", reason: "user" });
  });
});

describe("AiderObserver — walk + record real files", () => {
  let dir: string;
  before(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "lisa-aider-test-"));
  });
  after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test("walkHistories finds .aider.chat.history.md under roots, ignores node_modules/dotdirs", async () => {
    await fsp.mkdir(path.join(dir, "proj/node_modules/pkg"), { recursive: true });
    await fsp.mkdir(path.join(dir, "proj/.git"), { recursive: true });
    await fsp.writeFile(path.join(dir, "proj/.aider.chat.history.md"), "#### hi\nreply\n");
    await fsp.writeFile(path.join(dir, "proj/node_modules/pkg/.aider.chat.history.md"), "#### x\n");
    await fsp.writeFile(path.join(dir, "proj/.git/.aider.chat.history.md"), "#### y\n");
    const found = await walkHistories(dir);
    assert.equal(found.length, 1, "only the real project history, not node_modules/.git");
    assert.ok(found[0]!.endsWith("proj/.aider.chat.history.md"));
  });

  test("observer records discovered sessions with project + state", async () => {
    const proj = path.join(dir, "myrepo");
    await fsp.mkdir(proj, { recursive: true });
    await fsp.writeFile(
      path.join(proj, ".aider.chat.history.md"),
      "# aider chat started\n#### do the thing\nDone, applied.\n",
    );
    const obs = new AiderObserver({ enabled: true, watchRoots: [dir] });
    await obs.start(() => {});
    const sessions = obs.list();
    const mine = sessions.find((s) => s.project === "myrepo");
    assert.ok(mine, "found the myrepo session");
    assert.equal(mine!.agent, "aider");
    assert.equal(mine!.state, "waiting");
    assert.equal(mine!.cwd, proj);
    await obs.stop();
  });

  test("no watchRoots → observes nothing (aider has no central store)", async () => {
    const obs = new AiderObserver({ enabled: true });
    await obs.start(() => {});
    assert.deepEqual(obs.list(), []);
    await obs.stop();
  });
});
