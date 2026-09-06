import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HISTORY_LIMIT, loadHistory, normalizeHistory, saveHistory } from "./history.js";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-history-"));
after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("normalizeHistory", () => {
  test("drops blanks and consecutive duplicates, keeps distant repeats", () => {
    assert.deepEqual(normalizeHistory(["a", "", "  ", "a", "b", "a"]), ["a", "b", "a"]);
  });

  test("keeps the newest entries when over the cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => `q${i}`);
    assert.deepEqual(normalizeHistory(many, 3), ["q7", "q8", "q9"]);
  });

  test("strips a trailing CR so a file written on Windows round-trips", () => {
    assert.deepEqual(normalizeHistory(["a\r", "a"]), ["a"]);
  });

  test("the default cap is 1000", () => {
    assert.equal(HISTORY_LIMIT, 1000);
    const many = Array.from({ length: 1200 }, (_, i) => `q${i}`);
    const out = normalizeHistory(many);
    assert.equal(out.length, 1000);
    assert.equal(out[0], "q200");
  });
});

describe("loadHistory / saveHistory", () => {
  test("round-trips oldest-first and creates the file 0600", async () => {
    const file = path.join(tmp, "nested", "history");
    await saveHistory(["one", "two", "two", "", "three"], file);
    assert.deepEqual(await loadHistory(file), ["one", "two", "three"]);
    // Prompts routinely contain pasted secrets: owner-only, always.
    const mode = (await fs.stat(file)).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  });

  test("a missing file is an empty history, not an error", async () => {
    assert.deepEqual(await loadHistory(path.join(tmp, "nope", "history")), []);
  });

  test("saving replaces the file rather than appending", async () => {
    const file = path.join(tmp, "replace");
    await saveHistory(["a", "b"], file);
    await saveHistory(["c"], file);
    assert.deepEqual(await loadHistory(file), ["c"]);
    // …and leaves no temp file behind.
    const left = (await fs.readdir(tmp)).filter((n) => n.startsWith("replace."));
    assert.deepEqual(left, []);
  });

  test("an empty history writes an empty file", async () => {
    const file = path.join(tmp, "empty");
    await saveHistory(["", "   "], file);
    assert.equal(await fs.readFile(file, "utf8"), "");
    assert.deepEqual(await loadHistory(file), []);
  });

  test("the cap is enforced on write", async () => {
    const file = path.join(tmp, "capped");
    await saveHistory(
      Array.from({ length: 50 }, (_, i) => `q${i}`),
      file,
      5,
    );
    assert.deepEqual(await loadHistory(file), ["q45", "q46", "q47", "q48", "q49"]);
  });
});
