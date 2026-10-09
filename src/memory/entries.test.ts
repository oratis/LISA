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

  test("headings keep their level, prose stays single-line, bullets may span lines", async () => {
    writeStoreFile("MEMORY.md", "### Work\nsome prose\n- item\n");
    const { entries } = await readMemoryStore("memory");
    const [heading, prose, item] = entries;
    await replaceMemoryEntry(heading!.id, "Projects");
    await assert.rejects(
      replaceMemoryEntry(prose!.id, "two\nlines"),
      (e: MemoryEditError) => e.code === "invalid_entry",
    );
    const multi = await replaceMemoryEntry(item!.id, "first line\nsecond line");
    assert.equal(multi.text, "first line\nsecond line");
    assert.equal(readStoreFile("MEMORY.md"), "### Projects\nsome prose\n- first line\n  second line\n");
    await assert.rejects(appendMemoryEntry("memory", "bad\u0007bell"), (e: MemoryEditError) => e.code === "invalid_entry");
  });

  test("byte caps are enforced and an oversize file can still shrink", async () => {
    await assert.rejects(
      appendMemoryEntry("user", "x".repeat(2100)),
      (e: MemoryEditError) => e.code === "memory_full",
    );
    // A hand-edited file over its cap: flagged, appends refused, deletes allowed.
    writeStoreFile("USER.md", `- ${"a".repeat(1500)}\n- ${"b".repeat(1500)}\n`);
    const parsed = await readMemoryStore("user");
    assert.ok(parsed.warnings.some((w) => /over its 2048-byte cap/.test(w)));
    await assert.rejects(appendMemoryEntry("user", "more"), (e: MemoryEditError) => e.code === "memory_full");
    await deleteMemoryEntry(parsed.entries[0]!.id);
    assert.equal(readStoreFile("USER.md"), `- ${"b".repeat(1500)}\n`);
  });

  test("a corrupt file (NUL / invalid UTF-8) is listed but never rewritten", async () => {
    const bad = Buffer.concat([Buffer.from("- ok\n- nul\u0000here\n"), Buffer.from([0xff, 0xfe, 0x0a])]);
    writeStoreFile("MEMORY.md", bad);
    const parsed = await readMemoryStore("memory");
    assert.equal(parsed.corrupt, true);
    assert.ok(parsed.warnings.length >= 2);
    assert.ok(parsed.entries.length >= 2);
    for (const attempt of [
      () => appendMemoryEntry("memory", "x"),
      () => replaceMemoryEntry(parsed.entries[0]!.id, "y"),
      () => deleteMemoryEntry(parsed.entries[0]!.id),
    ]) {
      await assert.rejects(attempt(), (e: MemoryEditError) => e.code === "memory_corrupt");
    }
    assert.ok(fs.readFileSync(path.join(home, "memory", "MEMORY.md")).equals(bad));
  });

  test("concurrent edits from the API and the memory tool serialize on one lock", async () => {
    const { appendMemory, removeFromMemory } = await import("./store.js");
    writeStoreFile("MEMORY.md", "- drop me\n");
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => appendMemoryEntry("memory", `api ${i}`)),
      ...Array.from({ length: 5 }, (_, i) => appendMemory("memory", `tool ${i}`)),
      removeFromMemory("memory", "drop me"),
    ]);
    const { entries } = await readMemoryStore("memory");
    assert.equal(entries.length, 15);
    assert.ok(!entries.some((e) => e.text === "drop me"));
    assert.ok(!fs.existsSync(path.join(home, "memory", ".write.lock")), "lock released");
  });
});
