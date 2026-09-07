/**
 * T-5: the watcher's startup cost. CLAUDE_HOME is pinned BEFORE the dynamic
 * import because watcher.ts freezes PROJECTS_DIR at module load.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-ccwatch-"));
process.env.CLAUDE_HOME = TMP;
const PROJECTS = path.join(TMP, "projects");

const { ClaudeCodeWatcher } = await import("./watcher.js");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** A jsonl whose tail parses to a definite state, with a chosen mtime. */
function session(project: string, id: string, ageMs: number): string {
  const dir = path.join(PROJECTS, project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(
    file,
    [
      JSON.stringify({
        type: "user",
        cwd: "/Users/x/Projects/Demo",
        message: { role: "user", content: "hi" },
      }),
      JSON.stringify({
        type: "assistant",
        cwd: "/Users/x/Projects/Demo",
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "ok" }],
        },
      }),
    ].join("\n") + "\n",
  );
  pin(file, new Date(Date.now() - ageMs));
  return file;
}

/**
 * Pin mtime from a Date. Re-pinning with the SAME Date object reproduces the
 * same stat exactly; a Date rebuilt from a read-back mtimeMs does not, because
 * APFS stores nanoseconds and the ms readback is rounded.
 */
function pin(file: string, d: Date): void {
  fs.utimesSync(file, d, d);
}

describe("claude-code watcher startup (T-5)", () => {
  test("the initial scan only stats: cold sessions are recorded unparsed", async () => {
    // Two months-old sessions (outside the 30 min active window) and one fresh.
    session("-Users-x-Projects-Old", "aaaaaaaa-0000-0000-0000-000000000001", 60 * 24 * 3600_000);
    session("-Users-x-Projects-Old", "aaaaaaaa-0000-0000-0000-000000000002", 61 * 24 * 3600_000);
    const fresh = session("-Users-x-Projects-Demo", "bbbbbbbb-0000-0000-0000-000000000001", 1_000);

    const w = new ClaudeCodeWatcher();
    try {
      await w.start();

      // listActive() only ever surfaces the fresh one, and it IS parsed —
      // start() runs one repoll over the active window before the loop.
      const active = w.listActive();
      assert.equal(active.length, 1);
      assert.equal(active[0]!.jsonlPath, fresh);
      assert.notEqual(active[0]!.state, "unknown", "an active session is parsed at startup");
      assert.equal(active[0]!.cwd, "/Users/x/Projects/Demo", "cwd comes from the parse");

      // The cold ones were stat'd into the map but never opened: their state
      // is the stat-only placeholder. This is the assertion that fails if
      // someone puts the parse back into the scan.
      const all = w.snapshotAll();
      assert.equal(all.length, 3);
      const cold = all.filter((s) => s.stateReason === "unscanned");
      assert.equal(cold.length, 2);
      for (const c of cold) {
        assert.equal(c.state, "unknown");
        assert.equal(c.cwd, undefined, "cwd is only known after a parse");
        assert.ok(c.size > 0, "size still comes from the stat");
      }
    } finally {
      w.stop();
    }
  });

  test("a repoll of a stat-identical file reuses the parse instead of re-reading", async () => {
    const file = session("-Users-x-Projects-Demo", "cccccccc-0000-0000-0000-000000000001", 1_000);
    const when = new Date(Date.now() - 1_000);
    pin(file, when);
    const w = new ClaudeCodeWatcher();
    try {
      await w.start();
      const before = w.listActive().find((s) => s.jsonlPath === file)!;
      assert.ok(before);

      // Change the CONTENT while keeping (mtimeMs, size) — a re-read would
      // now parse garbage; a cache hit keeps the previous answer.
      const st = fs.statSync(file);
      fs.writeFileSync(file, Buffer.alloc(st.size, 0x20));
      pin(file, when);
      assert.equal(fs.statSync(file).mtimeMs, st.mtimeMs, "mtime restored exactly");
      assert.equal(fs.statSync(file).size, st.size, "size unchanged");
      await w.repollNow();

      const after2 = w.listActive().find((s) => s.jsonlPath === file)!;
      assert.equal(after2.state, before.state);
      assert.equal(after2.cwd, before.cwd);
    } finally {
      w.stop();
    }
  });
});
