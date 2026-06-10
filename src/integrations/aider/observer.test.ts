import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseAiderState,
  parseAiderActivity,
  walkHistories,
  AiderObserver,
} from "./observer.js";

const AID_SECRET = "SECRET_LEAK_CANARY_aid";

// A realistic aider 0.86 diff-format transcript: header + info lines, two user
// turns (#### …), two SEARCH/REPLACE edit blocks (path label on the line above
// the fence), and a litellm error line. The secret is planted in BOTH the
// prompt prose and inside the edit-block code bodies.
const AIDER_SAMPLE = [
  "# aider chat started at 2026-06-02 00:50:26",
  "> Added src/app/server.py to the chat.",
  "",
  `#### add a healthcheck route, password is ${AID_SECRET}`,
  "",
  "Sure — here is the edit:",
  "",
  "src/app/server.py",
  "```python",
  "<<<<<<< SEARCH",
  "def app():",
  "    pass",
  "=======",
  "def app():",
  `    SECRET = "${AID_SECRET}"  # leaked inside the code body`,
  "    return ok",
  ">>>>>>> REPLACE",
  "```",
  "",
  `#### now also tweak the config, keep ${AID_SECRET}`,
  "",
  "utils/config.go",
  "```go",
  "<<<<<<< SEARCH",
  "var Debug = false",
  "=======",
  `var Debug = true // ${AID_SECRET}`,
  ">>>>>>> REPLACE",
  "```",
  "",
  "> litellm.APIError: AnthropicException - overloaded_error, retrying in 5s. Full stack: traceback ...",
  "",
].join("\n");

describe("parseAiderActivity — Tier-2 structural extraction (honest fields only)", () => {
  test("extracts filesTouched from SEARCH/REPLACE path labels, turnCount, lastError", () => {
    const a = parseAiderActivity(AIDER_SAMPLE);
    assert.deepEqual(
      a.filesTouched,
      ["src/app/server.py", "utils/config.go"],
      "both edit-block path labels, in order",
    );
    assert.equal(a.turnCount, 2, "two #### user turns");
    assert.ok(a.lastError, "an error was surfaced");
    assert.ok(/litellm|APIError/i.test(a.lastError!), "error class captured");
    assert.ok(a.lastError!.length <= 80, "error is capped, not a full stack");
    assert.ok(!/traceback/i.test(a.lastError!), "no stack trace in the summary");
  });

  test("lastTools is intentionally [] — aider has no tool abstraction to read", () => {
    assert.deepEqual(parseAiderActivity(AIDER_SAMPLE).lastTools, []);
  });

  test("unavailable fields are undefined (no fabrication)", () => {
    const a = parseAiderActivity(AIDER_SAMPLE);
    assert.equal(a.tokens, undefined);
    assert.equal(a.gitBranch, undefined);
    assert.equal(a.pendingPermission, undefined);
  });

  test("PRIVACY: no secret from prompts or edit-block code bodies leaks", () => {
    const a = parseAiderActivity(AIDER_SAMPLE);
    const serialized = JSON.stringify(a);
    assert.equal(
      serialized.includes(AID_SECRET),
      false,
      `activity output leaked the secret: ${serialized}`,
    );
  });

  test("does not mistake the SEARCH marker's following code line for a path", () => {
    // No path label before the fence → nothing collected, no code captured.
    const md = [
      "#### edit it",
      "```python",
      "<<<<<<< SEARCH",
      "some/code/that/looks/like/a/path.py # but it's AFTER the marker",
      "=======",
      "x = 1",
      ">>>>>>> REPLACE",
      "```",
    ].join("\n");
    assert.deepEqual(parseAiderActivity(md).filesTouched, []);
  });

  test("dedupes repeated file paths and caps the list", () => {
    const block = (p: string) =>
      [p, "```py", "<<<<<<< SEARCH", "a", "=======", "b", ">>>>>>> REPLACE", "```"].join("\n");
    const md = [block("a/x.py"), block("a/x.py"), block("b/y.ts")].join("\n");
    assert.deepEqual(parseAiderActivity(md).filesTouched, ["a/x.py", "b/y.ts"]);
  });

  test("empty transcript → zeroed activity, still well-formed", () => {
    const a = parseAiderActivity("");
    assert.deepEqual(a.filesTouched, []);
    assert.deepEqual(a.lastTools, []);
    assert.equal(a.turnCount, 0);
    assert.equal(a.lastError, undefined);
  });
});

describe("AiderObserver — Tier-2 visibility gating", () => {
  let dir: string;
  before(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "lisa-aider-vis-"));
    await fsp.writeFile(path.join(dir, ".aider.chat.history.md"), AIDER_SAMPLE);
  });
  after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test('visibility "activity" → session carries parsed activity', async () => {
    const obs = new AiderObserver({ enabled: true, watchRoots: [dir], visibility: "activity" });
    await obs.start(() => {});
    const s = obs.list()[0]!;
    assert.ok(s.activity, "activity attached");
    assert.deepEqual(s.activity!.filesTouched, ["src/app/server.py", "utils/config.go"]);
    assert.equal(s.activity!.turnCount, 2);
    assert.equal(JSON.stringify(s.activity).includes(AID_SECRET), false, "no leak via observer");
    await obs.stop();
  });

  test('visibility "metadata" (and default) → no activity attached', async () => {
    for (const cfg of [
      { enabled: true, watchRoots: [dir], visibility: "metadata" as const },
      { enabled: true, watchRoots: [dir] },
    ]) {
      const obs = new AiderObserver(cfg);
      await obs.start(() => {});
      assert.equal(obs.list()[0]!.activity, undefined, "metadata/off stays metadata-only");
      await obs.stop();
    }
  });
});

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
