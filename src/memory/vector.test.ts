import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Point LISA_HOME at an empty temp dir BEFORE importing the module under
// test, so paths.ts (evaluated at import) resolves SESSIONS_DIR there.
// node's test runner isolates each test file in its own process, so this
// env mutation can't leak into other suites.
const TMP = mkdtempSync(path.join(os.tmpdir(), "lisa-mem-test-"));
process.env.LISA_HOME = TMP;

const { buildIndex, clearIndexCache } = await import("./vector.js");

after(() => rmSync(TMP, { recursive: true, force: true }));

describe("buildIndex — caching", () => {
  test("returns the same index object when sessions are unchanged", async () => {
    clearIndexCache();
    const a = await buildIndex();
    const b = await buildIndex();
    assert.equal(a, b, "second call should hit the cache (same reference)");
  });

  test("clearIndexCache forces a rebuild (new reference)", async () => {
    const a = await buildIndex();
    clearIndexCache();
    const b = await buildIndex();
    assert.notEqual(a, b, "after clear, a fresh index is built");
  });

  test("cache:false always rebuilds", async () => {
    const a = await buildIndex({ cache: false });
    const b = await buildIndex({ cache: false });
    assert.notEqual(a, b, "explicit cache:false bypasses the cache");
  });

  test("a new session file invalidates the cache (fingerprint changes)", async () => {
    clearIndexCache();
    const before = await buildIndex();
    // Write a session jsonl into SESSIONS_DIR (LISA_HOME/sessions). The
    // fingerprint (mtime+size of *.jsonl) changes, so the next build is fresh.
    const sessionsDir = path.join(TMP, "sessions");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(sessionsDir, { recursive: true });
    const header = JSON.stringify({ id: "s1", startedAt: "2026-05-28T00:00:00Z", cwd: "/x", model: "m" });
    const msg = JSON.stringify({ type: "message", message: { role: "user", content: "kubernetes deployment notes" } });
    writeFileSync(path.join(sessionsDir, "s1.jsonl"), header + "\n" + msg + "\n");
    const after = await buildIndex();
    assert.notEqual(before, after, "new session must bust the cache");
    assert.ok(after.docs.length >= 1, "the new session is indexed");
  });
});
