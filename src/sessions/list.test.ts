/**
 * Session index cache (T-4). Runs under a throwaway LISA_HOME set before the
 * dynamic import, because paths.ts reads the env at call time but the store
 * module freezes some paths at load.
 */
import { test, describe, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-sessions-"));
process.env.LISA_HOME = TMP;

const { clearSessionSummaryCache, listSessionsOnDisk, sessionSummaryCacheSize } =
  await import("./list.js");
const { sessionsDir } = await import("../paths.js");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function writeSession(
  id: string,
  userTexts: string[],
  startedAt = `2026-01-01T00:00:0${id.length % 10}Z`,
): string {
  const dir = sessionsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const lines = [JSON.stringify({ id, startedAt, cwd: "/tmp", model: "m" })];
  for (const t of userTexts) {
    lines.push(JSON.stringify({ type: "message", message: { role: "user", content: t } }));
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

/** Pin mtime to an exact millisecond so the (mtimeMs, size) key is scriptable. */
function pinMtime(file: string, ms: number): void {
  const d = new Date(ms);
  fs.utimesSync(file, d, d);
}

describe("listSessionsOnDisk cache", () => {
  beforeEach(() => clearSessionSummaryCache());

  test("summarizes a session the first time", async () => {
    writeSession("s1", ["hello there", "second"]);
    const list = await listSessionsOnDisk();
    const s1 = list.find((s) => s.id === "s1")!;
    assert.equal(s1.messageCount, 2);
    assert.equal(s1.firstUserMessage, "hello there");
    assert.equal(s1.lastUserMessage, "second");
    assert.equal(sessionSummaryCacheSize(), list.length);
  });

  test("an unchanged file is not re-read: the cached summary is returned verbatim", async () => {
    const file = writeSession("s2", ["one"]);
    pinMtime(file, 1_700_000_000_000);
    const first = await listSessionsOnDisk();
    const cached = first.find((s) => s.id === "s2")!;

    // Corrupt the file's CONTENT while keeping (mtimeMs, size) identical. If
    // the second call re-read it, the summary would vanish (unparseable).
    const size = fs.statSync(file).size;
    fs.writeFileSync(file, Buffer.alloc(size, 0x20)); // same length, all spaces
    pinMtime(file, 1_700_000_000_000);
    assert.equal(fs.statSync(file).size, size);

    const second = await listSessionsOnDisk();
    assert.deepEqual(
      second.find((s) => s.id === "s2"),
      cached,
      "served from cache, not re-parsed",
    );
  });

  test("appending to a session invalidates its entry (size changed)", async () => {
    const file = writeSession("s3", ["first"]);
    await listSessionsOnDisk();
    fs.appendFileSync(
      file,
      JSON.stringify({ type: "message", message: { role: "user", content: "appended" } }) + "\n",
    );
    const after2 = await listSessionsOnDisk();
    const s3 = after2.find((s) => s.id === "s3")!;
    assert.equal(s3.messageCount, 2);
    assert.equal(s3.lastUserMessage, "appended");
  });

  test("a rewrite of the same length invalidates via mtime", async () => {
    const file = writeSession("s4", ["aaaa"]);
    pinMtime(file, 1_700_000_000_000);
    const before = await listSessionsOnDisk();
    assert.equal(before.find((s) => s.id === "s4")!.lastUserMessage, "aaaa");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("aaaa", "bbbb"));
    pinMtime(file, 1_700_000_060_000); // same size, later mtime
    const after3 = await listSessionsOnDisk();
    assert.equal(after3.find((s) => s.id === "s4")!.lastUserMessage, "bbbb");
  });

  test("a deleted session is dropped from the cache, not served forever", async () => {
    const file = writeSession("s5", ["gone soon"]);
    await listSessionsOnDisk();
    const withIt = sessionSummaryCacheSize();
    fs.rmSync(file);
    const list = await listSessionsOnDisk();
    assert.equal(
      list.some((s) => s.id === "s5"),
      false,
    );
    assert.equal(sessionSummaryCacheSize(), withIt - 1);
  });

  test("the cache is bounded — 600 sessions never grow it past the cap", async () => {
    clearSessionSummaryCache();
    for (let i = 0; i < 600; i++) writeSession(`bulk${String(i).padStart(4, "0")}`, ["x"]);
    await listSessionsOnDisk();
    assert.ok(sessionSummaryCacheSize() <= 500, `cache is ${sessionSummaryCacheSize()}`);
  });
});
