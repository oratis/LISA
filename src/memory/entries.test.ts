import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  appendMemoryEntry,
  deleteMemoryEntry,
  MemoryEditError,
  parseMemoryEntries,
  readMemoryStore,
  replaceMemoryEntry,
} from "./entries.js";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.LISA_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-mem-entries-"));
  process.env.LISA_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function writeStoreFile(name: "MEMORY.md" | "USER.md", content: string | Buffer): void {
  fs.mkdirSync(path.join(home, "memory"), { recursive: true });
  fs.writeFileSync(path.join(home, "memory", name), content);
}

function readStoreFile(name: "MEMORY.md" | "USER.md"): string {
  return fs.readFileSync(path.join(home, "memory", name), "utf8");
}

describe("memory entries parsing", () => {
  test("parses bullets, continuations, headings and prose with stable ids", () => {
    const md = [
      "## Projects",
      "- likes TypeScript",
      "  and strict mode",
      "",
      "free prose line",
      "- likes TypeScript",
    ].join("\n");
    const entries = parseMemoryEntries("memory", md);
    assert.deepEqual(
      entries.map((e) => [e.kind, e.text, e.line]),
      [
        ["heading", "Projects", 1],
        ["bullet", "likes TypeScript\nand strict mode", 2],
        ["text", "free prose line", 5],
        ["bullet", "likes TypeScript", 6],
      ],
    );
    for (const e of entries) assert.match(e.id, /^m_[0-9a-f]{16}$/);
    assert.equal(new Set(entries.map((e) => e.id)).size, entries.length);
    // Ids survive an unrelated edit elsewhere in the file.
    const again = parseMemoryEntries("memory", `- new first\n${md}`);
    for (const e of entries) assert.ok(again.some((a) => a.id === e.id), e.text);
  });

  test("duplicate entries get distinct ids by ordinal", () => {
    const entries = parseMemoryEntries("user", "- same\n- same\n");
    assert.equal(entries.length, 2);
    assert.notEqual(entries[0]!.id, entries[1]!.id);
    assert.match(entries[0]!.id, /^u_/);
  });
});

describe("memory entries edit/delete", () => {
  test("append, replace, delete round-trip keeps other entries intact", async () => {
    writeStoreFile("MEMORY.md", "# Notes\n- keep me\n- edit me\n");
    const before = await readMemoryStore("memory");
    const edit = before.entries.find((e) => e.text === "edit me")!;
    const keep = before.entries.find((e) => e.text === "keep me")!;

    const replaced = await replaceMemoryEntry(edit.id, "edited");
    assert.equal(replaced.text, "edited");
    assert.equal(readStoreFile("MEMORY.md"), "# Notes\n- keep me\n- edited\n");

    const added = await appendMemoryEntry("memory", "appended");
    assert.equal(added.text, "appended");
    await deleteMemoryEntry(keep.id);
    assert.equal(readStoreFile("MEMORY.md"), "# Notes\n- edited\n- appended\n");

    // The old id no longer resolves (content-addressed).
    await assert.rejects(replaceMemoryEntry(edit.id, "x"), (e: MemoryEditError) => e.code === "not_found");

    const audit = fs.readFileSync(path.join(home, "sovereignty", "audit.jsonl"), "utf8");
    const lines = audit.trim().split("\n").map((l) => JSON.parse(l) as { action: string });
    assert.deepEqual(
      lines.map((l) => l.action),
      ["memory.replace", "memory.append", "memory.delete"],
    );
    assert.ok(!audit.includes("edited") && !audit.includes("appended"), "audit holds no content");
  });
});
