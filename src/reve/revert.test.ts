import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LISA_KB_NO_GIT = "1";
process.env.LISA_SOUL_GIT = "0";

const { withDream } = await import("./record.js");
const { listDreams, readDream } = await import("./store.js");
const { revertDream, RevertConflictError, RevertInputError, parseRevertParts } =
  await import("./revert.js");
const { appendMemory } = await import("../memory/store.js");
const { createSkill, patchSkill } = await import("../skills/manager.js");
const soulStore = await import("../soul/store.js");

let home: string;
const savedHome = process.env.LISA_HOME;

const read = (rel: string) => fs.readFileSync(path.join(home, rel), "utf8");
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
  fs.writeFileSync(path.join(home, rel), text);
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-reve-revert-"));
  process.env.LISA_HOME = home;
  write("memory/MEMORY.md", "- user prefers tea\n");
  write("kb/wiki/rust.md", "# Rust\n\nA systems language.\n");
  write("soul/identity.md", "I am Lisa.\n");
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

async function idleDream(fn: () => Promise<void>): Promise<string> {
  await withDream({ trigger: "idle" }, fn);
  const { dreams } = await listDreams(1);
  return dreams[0]!.id;
}

describe("revert of user-owned data", () => {
  test("restores memory and KB exactly, leaves the soul alone, and audits", async () => {
    const id = await idleDream(async () => {
      await appendMemory("memory", "user is learning Rust");
      write("kb/wiki/rust.md", "# Rust\n\nA systems language. Lisa rewrote this.\n");
      write("kb/wiki/cargo.md", "# Cargo\n");
      await soulStore.writeIdentity("I am Lisa, reborn.");
    });
    const res = await revertDream(id, { parts: ["memory", "kb"] });
    assert.deepEqual(res.reverted.sort(), [
      "kb/wiki/cargo.md",
      "kb/wiki/rust.md",
      "memory/MEMORY.md",
    ]);
    assert.equal(read("memory/MEMORY.md"), "- user prefers tea\n");
    assert.equal(read("kb/wiki/rust.md"), "# Rust\n\nA systems language.\n");
    assert.equal(fs.existsSync(path.join(home, "kb/wiki/cargo.md")), false, "added page removed");
    assert.equal(
      read("soul/identity.md"),
      "I am Lisa, reborn.\n",
      "soul untouched by a user revert",
    );

    const rec = await readDream(id);
    assert.equal(rec.reverts.length, 1);
    assert.deepEqual(rec.reverts[0]!.parts, ["memory", "kb"]);
    const audit = read("reve/audit.jsonl")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(audit.at(-1).action, "revert");
    assert.equal(audit.at(-1).dreamId, id);

    // Idempotent: a second revert finds everything already restored.
    const again = await revertDream(id, { parts: ["memory", "kb"] });
    assert.deepEqual(again.reverted, []);
    assert.equal(again.alreadyReverted.length, 3);
  });

  test("refuses with a conflict when the file changed since the dream, unless forced", async () => {
    const id = await idleDream(async () => {
      await appendMemory("memory", "dream entry");
    });
    await appendMemory("memory", "the user added this afterwards");
    const modified = read("memory/MEMORY.md");
    await assert.rejects(revertDream(id, { parts: ["memory"] }), (err: unknown) => {
      assert.ok(err instanceof RevertConflictError);
      assert.deepEqual(err.conflicts, [{ path: "memory/MEMORY.md", reason: "modified_since" }]);
      return true;
    });
    assert.equal(read("memory/MEMORY.md"), modified, "nothing written on conflict");
    const forced = await revertDream(id, { parts: ["memory"], force: true });
    assert.deepEqual(forced.reverted, ["memory/MEMORY.md"]);
    assert.equal(forced.forced, true);
    assert.equal(read("memory/MEMORY.md"), "- user prefers tea\n");
  });

  test("a conflict in one file blocks the whole revert (no partial state)", async () => {
    const id = await idleDream(async () => {
      await appendMemory("memory", "dream entry");
      write("kb/wiki/rust.md", "# Rust v2\n");
    });
    write("kb/wiki/rust.md", "# Rust v3 by the user\n");
    const memAfterDream = read("memory/MEMORY.md");
    await assert.rejects(revertDream(id, { parts: ["memory", "kb"] }), RevertConflictError);
    assert.equal(read("memory/MEMORY.md"), memAfterDream);
  });

  test("reverts only the skills Lisa created or patched in that dream", async () => {
    await createSkill({ name: "deploy", description: "deploy the app" }, "run npm publish\n");
    await createSkill({ name: "notes", description: "user's own" }, "keep it short\n");
    const before = read("skills/deploy/SKILL.md");
    const id = await idleDream(async () => {
      await patchSkill("deploy", "npm publish", "npm publish --access public");
      await createSkill({ name: "fresh", description: "new in the dream" }, "body\n");
    });
    const res = await revertDream(id, { parts: ["skills"] });
    assert.deepEqual(res.reverted.sort(), ["skills/deploy/SKILL.md", "skills/fresh/SKILL.md"]);
    assert.equal(read("skills/deploy/SKILL.md"), before);
    assert.equal(fs.existsSync(path.join(home, "skills/fresh")), false);
    assert.ok(fs.existsSync(path.join(home, "skills/notes/SKILL.md")), "untouched skill kept");
  });

  test("soul is never a revertible part", () => {
    assert.throws(() => parseRevertParts(["soul"]), RevertInputError);
    assert.throws(() => parseRevertParts(["memory", "identity"]), RevertInputError);
    assert.throws(() => parseRevertParts([]), RevertInputError);
    assert.deepEqual(parseRevertParts("memory,kb"), ["memory", "kb"]);
  });

  test("a tampered record path cannot escape the user parts", async () => {
    const id = await idleDream(async () => {
      await appendMemory("memory", "dream entry");
    });
    const file = path.join(home, "reve", "dreams", `${id}.json`);
    const rec = JSON.parse(fs.readFileSync(file, "utf8"));
    rec.changes[0].path = "soul/identity.md";
    rec.changes[0].part = "memory";
    fs.writeFileSync(file, JSON.stringify(rec));
    await assert.rejects(revertDream(id, { parts: ["memory"] }), (err: unknown) => {
      assert.ok(err instanceof RevertConflictError);
      assert.equal(err.conflicts[0]!.reason, "not_revertible");
      return true;
    });
    assert.equal(read("soul/identity.md"), "I am Lisa.\n");
  });
});
