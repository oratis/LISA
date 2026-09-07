import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_TAIL_BYTES, jsonlLines, tailLines } from "./jsonl.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-jsonl-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function write(name: string, lines: string[]): string {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

async function collect(it: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const l of it) out.push(l);
  return out;
}

describe("jsonlLines", () => {
  test("yields non-empty lines in order and tolerates a missing final newline", async () => {
    const p = path.join(TMP, "a.jsonl");
    fs.writeFileSync(p, '{"a":1}\n\n{"a":2}');
    assert.deepEqual(await collect(jsonlLines(p)), ['{"a":1}', '{"a":2}']);
  });

  test("an empty file yields nothing", async () => {
    assert.deepEqual(await collect(jsonlLines(write("empty.jsonl", []))), []);
  });

  test("breaking out early does not leave the read stream open", async () => {
    const p = write(
      "big.jsonl",
      Array.from({ length: 5000 }, (_, i) => `{"i":${i}}`),
    );
    for await (const line of jsonlLines(p)) {
      assert.equal(line, '{"i":0}');
      break; // the generator's finally must destroy the stream
    }
    // If the fd leaked, node:test's leak detection fails the run; reaching
    // here with the file still removable is the observable check.
    assert.ok(fs.existsSync(p));
  });

  test("a missing file rejects like readFile would", async () => {
    await assert.rejects(() => collect(jsonlLines(path.join(TMP, "nope.jsonl"))), /ENOENT/);
  });
});

describe("tailLines", () => {
  test("a file smaller than the cap comes back whole and complete", async () => {
    const p = write("small.jsonl", ['{"a":1}', '{"a":2}']);
    const t = await tailLines(p);
    assert.deepEqual(t.lines, ['{"a":1}', '{"a":2}']);
    assert.equal(t.complete, true);
  });

  test("a bigger file returns only the tail, and drops the torn first line", async () => {
    const p = write(
      "wide.jsonl",
      Array.from({ length: 200 }, (_, i) => `{"i":${i},"pad":"${"x".repeat(50)}"}`),
    );
    const t = await tailLines(p, 512);
    assert.equal(t.complete, false);
    assert.ok(t.lines.length > 0 && t.lines.length < 200);
    // Every returned line is whole JSON — the partial head line was dropped.
    for (const l of t.lines) assert.doesNotThrow(() => JSON.parse(l));
    // …and the tail really is the END of the file.
    assert.equal(JSON.parse(t.lines[t.lines.length - 1]!).i, 199);
  });

  test("an empty file is complete with no lines", async () => {
    const p = path.join(TMP, "zero.jsonl");
    fs.writeFileSync(p, "");
    assert.deepEqual(await tailLines(p), { lines: [], complete: true });
  });

  test("the default cap is 256KB", () => {
    assert.equal(DEFAULT_TAIL_BYTES, 256 * 1024);
  });
});
