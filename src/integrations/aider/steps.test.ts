import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseAiderSteps } from "./observer.js";

/**
 * Aider step-timeline: STRUCTURAL MARKERS ONLY — user turns, collapsed tool
 * runs, assistant blocks. No transcript text may reach the output.
 */

const SECRET = "A1DER-S3CR3T-42kq";

test("parseAiderSteps: turn boundaries only, no transcript leakage", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-aider-steps-"));
  const file = path.join(dir, ".aider.chat.history.md");
  const md = [
    "# aider chat started at 2026-08-08 03:00:00",
    "> Aider v0.86 " + SECRET,
    "> Added foo.py to the chat.",
    "#### fix the bug in " + SECRET + ".py",
    "Looking at the file, the bug is " + SECRET,
    "more prose",
    "> Applied edit to " + SECRET + ".py",
    "#### thanks, now add tests",
    "Sure — adding tests. " + SECRET,
  ].join("\n");
  await fs.writeFile(file, md);

  const steps = await parseAiderSteps(file);
  // tool(收尾 header block) → user(1) → assistant → tool → user(2) → assistant
  const kinds = steps.map((s) => s.kind);
  assert.deepEqual(kinds, ["tool", "user", "assistant", "tool", "user", "assistant"]);
  assert.equal(steps[1]!.turn, 1);
  assert.equal(steps[4]!.turn, 2);
  for (const s of steps) {
    if (s.kind === "tool") assert.equal(s.tool, "aider");
    assert.equal(s.target, undefined); // never a name/path from prose
  }
  assert.ok(!JSON.stringify(steps).includes(SECRET), "transcript text leaked");
  await fs.rm(dir, { recursive: true, force: true });
});
