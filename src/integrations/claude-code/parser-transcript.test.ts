import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseSessionTranscript } from "./parser.js";
import { parseCodexTranscript } from "../codex/observer.js";

/**
 * Transcript privacy tests (确认轮三). The transcript IS allowed to carry
 * user/assistant message text — that is its purpose (owner's local view,
 * loopback-only endpoint). What must STILL never leak: tool inputs (full
 * commands, edit payloads), tool_result contents, and full paths. A tool
 * secret is planted in all of those; a message marker must come through.
 */

const TOOL_SECRET = "T00L-S3CR3T-91fe";
const USER_TEXT = "please fix the login bug";
const AGENT_TEXT = "Done — the fix is in `auth.ts`.";

function line(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

async function withFile(name: string, data: string, fn: (file: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-transcript-"));
  const file = path.join(dir, name);
  await fs.writeFile(file, data);
  try {
    await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("claude-code transcript: message text present, tool payloads absent", async () => {
  const jsonl =
    line({
      type: "user",
      timestamp: "2026-08-08T01:00:00Z",
      message: { role: "user", content: [{ type: "text", text: USER_TEXT }] },
    }) +
    line({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", name: "Edit", input: { file_path: "/Users/x/" + TOOL_SECRET + "-dir/auth.ts", old_string: TOOL_SECRET, new_string: TOOL_SECRET } },
          { type: "tool_use", name: "Bash", input: { command: "git commit -m " + TOOL_SECRET } },
        ],
      },
    }) +
    line({
      type: "user",
      is_error: true,
      message: { role: "user", content: [{ type: "tool_result", content: TOOL_SECRET }] },
    }) +
    line({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: AGENT_TEXT }] },
    });

  await withFile("abc.jsonl", jsonl, async (file) => {
    const entries = await parseSessionTranscript(file);
    const kinds = entries.map((e) => e.kind);
    assert.deepEqual(kinds, ["user", "tool", "tool", "assistant"]);
    assert.equal(entries[0]!.text, USER_TEXT);
    assert.equal(entries[0]!.turn, 1);
    assert.equal(entries[1]!.tool, "Edit");
    assert.equal(entries[1]!.target, "auth.ts"); // basename only
    assert.equal(entries[2]!.target, "$ git"); // argv[0] only
    assert.equal(entries[2]!.isError, true); // error attributed to the LATEST tool
    assert.equal(entries[3]!.text, AGENT_TEXT);
    assert.ok(!JSON.stringify(entries).includes(TOOL_SECRET), "tool payload leaked");
  });
});

test("codex transcript: message text present, arguments/output absent", async () => {
  const jsonl =
    line({ type: "user", timestamp: "2026-08-08T02:00:00Z", message: { role: "user", content: USER_TEXT } }) +
    line({ type: "function_call", name: "shell", arguments: JSON.stringify({ command: "echo " + TOOL_SECRET }) }) +
    line({ type: "function_call_output", is_error: true, output: TOOL_SECRET }) +
    line({ type: "response", message: { role: "assistant", content: [{ type: "output_text", text: AGENT_TEXT }] } });

  await withFile("rollout-x.jsonl", jsonl, async (file) => {
    const entries = await parseCodexTranscript(file);
    const kinds = entries.map((e) => e.kind);
    assert.deepEqual(kinds, ["user", "tool", "assistant"]);
    assert.equal(entries[0]!.text, USER_TEXT);
    assert.equal(entries[1]!.tool, "shell");
    assert.equal(entries[1]!.target, "$ echo");
    assert.equal(entries[1]!.isError, true);
    assert.equal(entries[2]!.text, AGENT_TEXT);
    assert.ok(!JSON.stringify(entries).includes(TOOL_SECRET), "tool payload leaked");
  });
});
