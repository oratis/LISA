import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseSessionState } from "./parser.js";

// The parser reads the TAIL of a real file, so we exercise it against
// temp jsonl fixtures — this covers the actual on-disk path (tail read,
// line splitting, bottom-up walk) rather than just the decision fn.
let dir: string;

before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "lisa-parser-test-"));
});
after(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

let counter = 0;
async function writeJsonl(lines: object[]): Promise<string> {
  const p = path.join(dir, `session-${counter++}.jsonl`);
  await fsp.writeFile(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

describe("parseSessionState — state derivation", () => {
  test("assistant end_turn → waiting", async () => {
    const f = await writeJsonl([
      { type: "user", cwd: "/Users/x/proj", message: { role: "user" } },
      { type: "assistant", cwd: "/Users/x/proj", message: { role: "assistant", stop_reason: "end_turn" } },
    ]);
    const s = await parseSessionState(f);
    assert.equal(s.state, "waiting");
    assert.equal(s.reason, "end_turn");
    assert.equal(s.cwd, "/Users/x/proj");
  });

  test("assistant tool_use → working", async () => {
    const f = await writeJsonl([
      { type: "assistant", cwd: "/p", message: { role: "assistant", stop_reason: "tool_use" } },
    ]);
    const s = await parseSessionState(f);
    assert.equal(s.state, "working");
    assert.equal(s.reason, "tool_use");
  });

  test("user line → working (Claude about to respond)", async () => {
    const f = await writeJsonl([
      { type: "assistant", cwd: "/p", message: { stop_reason: "end_turn" } },
      { type: "user", cwd: "/p", message: { role: "user" } },
    ]);
    const s = await parseSessionState(f);
    assert.equal(s.state, "working");
    assert.equal(s.reason, "user");
  });

  test("is_error true → error", async () => {
    const f = await writeJsonl([
      { type: "assistant", cwd: "/p", is_error: true, message: { stop_reason: "end_turn" } },
    ]);
    const s = await parseSessionState(f);
    assert.equal(s.state, "error");
  });

  test("hookErrors > 0 → error", async () => {
    const f = await writeJsonl([
      { type: "system", cwd: "/p", hookErrors: 2 },
    ]);
    const s = await parseSessionState(f);
    assert.equal(s.state, "error");
  });

  test("system permission subtype → waiting/permission", async () => {
    const f = await writeJsonl([
      { type: "assistant", cwd: "/p", message: { stop_reason: "tool_use" } },
      { type: "system", cwd: "/p", subtype: "tool_permission_request" },
    ]);
    const s = await parseSessionState(f);
    assert.equal(s.state, "waiting");
    assert.equal(s.reason, "permission");
  });
});

describe("parseSessionState — META_TYPES are skipped", () => {
  test("pr-link as last line does not mask the real assistant state", async () => {
    // pr-link is written when Claude Code opens a PR; it appears AFTER the
    // conversation and must not be treated as the session's live state.
    const f = await writeJsonl([
      { type: "assistant", cwd: "/p", message: { stop_reason: "end_turn" } },
      { type: "pr-link", prNumber: 42, prUrl: "https://example/pr/42" },
      { type: "ai-title" },
      { type: "custom-title" },
    ]);
    const s = await parseSessionState(f);
    assert.equal(s.state, "waiting", "should walk past pr-link/title meta entries");
    assert.equal(s.reason, "end_turn");
  });
});

describe("parseSessionState — robustness", () => {
  test("empty file → unknown", async () => {
    const p = path.join(dir, "empty.jsonl");
    await fsp.writeFile(p, "");
    const s = await parseSessionState(p);
    assert.equal(s.state, "unknown");
  });

  test("missing file → unknown (no throw)", async () => {
    const s = await parseSessionState(path.join(dir, "does-not-exist.jsonl"));
    assert.equal(s.state, "unknown");
  });

  test("malformed JSON lines are skipped, last valid wins", async () => {
    const p = path.join(dir, "malformed.jsonl");
    await fsp.writeFile(
      p,
      [
        JSON.stringify({ type: "assistant", cwd: "/p", message: { stop_reason: "end_turn" } }),
        "{ this is not valid json",
        "also garbage }}}",
      ].join("\n") + "\n",
    );
    const s = await parseSessionState(p);
    // The garbage trailing lines are unparseable → skipped; the walk falls
    // back to the valid end_turn line above them.
    assert.equal(s.state, "waiting");
  });

  test("cwd is sniffed from top-level field only", async () => {
    const f = await writeJsonl([
      { type: "assistant", cwd: "/Users/me/code/thing", message: { stop_reason: "tool_use" } },
    ]);
    const s = await parseSessionState(f);
    assert.equal(s.cwd, "/Users/me/code/thing");
  });

  test("only-meta file → unknown but still sniffs cwd", async () => {
    const f = await writeJsonl([
      { type: "ai-title", cwd: "/p" },
      { type: "custom-title", cwd: "/p" },
    ]);
    const s = await parseSessionState(f);
    assert.equal(s.state, "unknown");
    assert.equal(s.cwd, "/p");
  });
});
