import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseSessionSteps } from "./parser.js";

/**
 * parseSessionSteps privacy + shape tests (PLAN_UI_SESSION_SHELL_v1.1 F1).
 *
 * Same secret-planting technique as parser.test.ts: a unique marker is
 * embedded in every content-bearing position (user text, assistant text,
 * tool_result payload, full Bash command, parent DIRECTORY of a file path)
 * and must never appear in the parsed output. Step targets are file
 * basenames / Bash argv[0] only.
 */

const SECRET = "S3CR3T-ne-pas-fuir-9f2d";

function line(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

async function withSession(jsonl: string, fn: (file: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-steps-"));
  const file = path.join(dir, "abc.jsonl");
  await fs.writeFile(file, jsonl);
  try {
    await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("parseSessionSteps: ordered structural steps, no content leakage", async () => {
  const jsonl =
    line({
      type: "user",
      timestamp: "2026-08-08T01:00:00Z",
      message: { role: "user", content: [{ type: "text", text: SECRET + " please fix the bug" }] },
    }) +
    line({
      type: "assistant",
      timestamp: "2026-08-08T01:00:05Z",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", name: "Read", input: { file_path: "/Users/x/" + SECRET + "-dir/notes.md" } },
        ],
      },
    }) +
    // tool_result envelope (type:user but NOT a human turn) carrying an error
    line({
      type: "user",
      is_error: true,
      message: { role: "user", content: [{ type: "tool_result", content: SECRET }] },
    }) +
    line({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Bash", input: { command: "grep " + SECRET + " -r ." } }],
      },
    }) +
    line({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "done: " + SECRET }] },
    }) +
    line({
      type: "user",
      timestamp: "2026-08-08T01:01:00Z",
      message: { role: "user", content: [{ type: "text", text: "next " + SECRET }] },
    });

  await withSession(jsonl, async (file) => {
    const steps = await parseSessionSteps(file);

    // Order + turn attribution: user(1) → Read → Bash → assistant → user(2)
    assert.equal(steps.length, 5);
    assert.equal(steps[0]!.kind, "user");
    assert.equal(steps[0]!.turn, 1);
    assert.equal(steps[0]!.ts, "2026-08-08T01:00:00Z");

    const read = steps.find((s) => s.tool === "Read");
    assert.ok(read, "Read tool step present");
    assert.equal(read!.target, "notes.md"); // basename only — directory (with secret) stripped
    assert.equal(read!.turn, 1);
    assert.equal(read!.isError, true); // is_error tool_result attributed to latest tool

    const bash = steps.find((s) => s.tool === "Bash");
    assert.ok(bash, "Bash tool step present");
    assert.equal(bash!.target, "$ grep"); // argv[0] only

    const assistants = steps.filter((s) => s.kind === "assistant");
    assert.equal(assistants.length, 1); // tool_use-only assistant lines are not text markers

    assert.equal(steps[steps.length - 1]!.kind, "user");
    assert.equal(steps[steps.length - 1]!.turn, 2);

    // The privacy assertion: the planted secret appears nowhere.
    assert.ok(!JSON.stringify(steps).includes(SECRET), "secret leaked into steps output");
  });
});

test("parseSessionSteps: empty / missing / malformed files return []", async () => {
  assert.deepEqual(await parseSessionSteps("/nonexistent/file.jsonl"), []);
  await withSession("", async (file) => {
    assert.deepEqual(await parseSessionSteps(file), []);
  });
  await withSession("not json\n{broken\n", async (file) => {
    assert.deepEqual(await parseSessionSteps(file), []);
  });
});
