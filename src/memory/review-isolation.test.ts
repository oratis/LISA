import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { homeScope } from "../paths.js";
import {
  prepareMemoryReview,
  consolidateMemory,
  readMemoryRevision,
  recentMemoryRevisions,
  restoreMemoryRevision,
} from "./review.js";
import { recentMemoryEvidence } from "./evidence.js";
import { readMemory, writeMemory } from "./store.js";

test("private evidence and versions stay in the active home across directory and file links", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-reve-isolation-"));
  const a = path.join(dir, "a"),
    b = path.join(dir, "b");
  try {
    const rev = await homeScope.run(b, async () => {
      await writeMemory("user", "- Private tenant preference");
      const draft = await prepareMemoryReview("user", []);
      return consolidateMemory(draft.id, []);
    });
    await fs.mkdir(path.join(b, "sessions"));
    await fs.writeFile(
      path.join(b, "sessions", "source.jsonl"),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "Private tenant conversation" },
      }) + "\n",
    );
    await fs.mkdir(path.join(a, "memory"), { recursive: true });
    await fs.symlink(path.join(b, "sessions"), path.join(a, "sessions"));
    await fs.symlink(path.join(b, "memory", "revisions"), path.join(a, "memory", "revisions"));
    await fs.symlink(path.join(b, "memory", "reviews"), path.join(a, "memory", "reviews"));
    await homeScope.run(a, async () => {
      await assert.rejects(recentMemoryEvidence());
      await assert.rejects(recentMemoryEvidence(["source"]));
      await assert.rejects(recentMemoryRevisions());
      await assert.rejects(readMemoryRevision(rev.revisionId));
      await assert.rejects(restoreMemoryRevision(rev.revisionId));
      await assert.rejects(prepareMemoryReview("user", []));
      await assert.rejects(consolidateMemory(rev.revisionId, []));
      await fs.unlink(path.join(a, "memory", "revisions"));
      await fs.mkdir(path.join(a, "memory", "revisions"));
      const file = path.join("memory", "revisions", `${rev.revisionId}.json`);
      await fs.symlink(path.join(b, file), path.join(a, file));
      await assert.rejects(readMemoryRevision(rev.revisionId));
      assert.deepEqual(await recentMemoryRevisions(), []);
      await fs.symlink(path.join(b, "memory", "USER.md"), path.join(a, "memory", "USER.md"));
      await assert.rejects(readMemory("user"));
      await assert.rejects(writeMemory("user", "another value"));
    });
    await homeScope.run(b, async () => {
      assert.equal(await readMemory("user"), "- Private tenant preference\n");
      assert.equal((await recentMemoryRevisions()).length, 1);
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
