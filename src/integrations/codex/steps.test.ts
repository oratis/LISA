import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseCodexSteps } from "./observer.js";

/** Codex step-timeline privacy + shape (PLAN_UI_SESSION_SHELL_v1.1 收尾). */

const SECRET = "C0DEX-S3CR3T-77ab";

function line(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

test("parseCodexSteps: ordered structural steps, no content leakage", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-codex-steps-"));
  const file = path.join(dir, "rollout-x.jsonl");
  const jsonl =
    line({ type: "user", timestamp: "2026-08-08T03:00:00Z", message: { role: "user", content: SECRET + " do the thing" } }) +
    line({ type: "function_call", name: "read_file", arguments: JSON.stringify({ file_path: "/Users/x/" + SECRET + "-dir/notes.md" }) }) +
    line({ type: "function_call_output", is_error: true, output: SECRET }) +
    line({ type: "function_call", name: "shell", arguments: JSON.stringify({ command: "grep " + SECRET + " -r ." }) }) +
    line({ type: "response", message: { role: "assistant", content: "done " + SECRET } }) +
    line({ type: "user", message: { role: "user", content: "next " + SECRET } });
  await fs.writeFile(file, jsonl);

  const steps = await parseCodexSteps(file);
  assert.equal(steps[0]!.kind, "user");
  assert.equal(steps[0]!.turn, 1);
  const read = steps.find((s) => s.tool === "read_file");
  assert.ok(read, "read_file step present");
  assert.equal(read!.target, "notes.md"); // basename only
  assert.equal(read!.isError, true); // function_call_output error attributed
  const shell = steps.find((s) => s.tool === "shell");
  assert.equal(shell!.target, "$ grep"); // argv[0] only
  assert.equal(steps[steps.length - 1]!.kind, "user");
  assert.equal(steps[steps.length - 1]!.turn, 2);
  assert.ok(!JSON.stringify(steps).includes(SECRET), "secret leaked");
  await fs.rm(dir, { recursive: true, force: true });
});
