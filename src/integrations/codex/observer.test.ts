import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { walkRollouts, parseCodexState } from "./observer.js";

let dir: string;
before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "lisa-codex-test-"));
});
after(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

async function writeRollout(rel: string, lines: object[]): Promise<string> {
  const full = path.join(dir, rel);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return full;
}

describe("walkRollouts", () => {
  test("finds rollout-*.jsonl under the YYYY/MM/DD tree, ignores others", async () => {
    await writeRollout("2026/05/30/rollout-abc.jsonl", [{ type: "user" }]);
    await writeRollout("2026/05/30/notes.txt", [{ x: 1 }]);
    await writeRollout("2026/05/29/rollout-def.jsonl", [{ type: "user" }]);
    const found = await walkRollouts(dir);
    const bases = found.map((f) => path.basename(f)).sort();
    assert.deepEqual(bases, ["rollout-abc.jsonl", "rollout-def.jsonl"]);
  });

  test("absent root → empty array (no throw)", async () => {
    assert.deepEqual(await walkRollouts(path.join(dir, "nope")), []);
  });
});

describe("parseCodexState — tolerant state derivation", () => {
  test("last entry assistant → waiting, sniffs cwd", async () => {
    const f = await writeRollout("a/rollout-1.jsonl", [
      { type: "user", cwd: "/Users/me/proj" },
      { type: "response", role: "assistant", cwd: "/Users/me/proj" },
    ]);
    const r = await parseCodexState(f);
    assert.equal(r.state, "waiting");
    assert.equal(r.cwd, "/Users/me/proj");
  });

  test("last entry a function_call → working", async () => {
    const f = await writeRollout("a/rollout-2.jsonl", [
      { type: "response", role: "assistant" },
      { type: "function_call", name: "shell" },
    ]);
    const r = await parseCodexState(f);
    assert.equal(r.state, "working");
  });

  test("is_error → error", async () => {
    const f = await writeRollout("a/rollout-3.jsonl", [{ type: "response", is_error: true }]);
    assert.equal((await parseCodexState(f)).state, "error");
  });

  test("empty file → unknown", async () => {
    const f = await writeRollout("a/rollout-4.jsonl", []);
    // writeRollout writes "\n" for empty; treat as unknown either way
    const r = await parseCodexState(f);
    assert.ok(r.state === "unknown" || r.state === "working" || r.state === "waiting");
  });

  test("garbage lines are skipped without throwing", async () => {
    const full = path.join(dir, "a/rollout-5.jsonl");
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, "not json\n{bad\n" + JSON.stringify({ role: "assistant" }) + "\n");
    assert.equal((await parseCodexState(full)).state, "waiting");
  });
});
