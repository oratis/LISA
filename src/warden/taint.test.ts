import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_TAINTED_CONVERSATIONS,
  isConversationTainted,
  loadTaintState,
  markConversationTainted,
} from "./taint.js";
import { loadDigestKey, wardenDir } from "./store.js";

async function tmpHome(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "lisa-warden-taint-"));
}
const file = (home: string) => path.join(wardenDir(home), "tainted.json");

test("review 7: conversation taint is persisted as ids only, atomically, mode 0600", async () => {
  const home = await tmpHome();
  assert.equal(await isConversationTainted("c1", { home, hasHistory: true }), false);
  await markConversationTainted("c1", home);
  await markConversationTainted("c2", home);
  await markConversationTainted("c1", home);
  assert.deepEqual(JSON.parse(await fs.readFile(file(home), "utf8")), {
    version: 1,
    ids: ["c2", "c1"],
  });
  assert.equal((await fs.stat(file(home))).mode & 0o777, 0o600);
  assert.equal(await isConversationTainted("c1", { home, hasHistory: false }), true);
  assert.equal(await isConversationTainted("c3", { home, hasHistory: true }), false);
});

test("review 7: the store is bounded; the oldest conversation is forgotten first", async () => {
  const home = await tmpHome();
  await fs.mkdir(wardenDir(home), { recursive: true });
  const ids = Array.from({ length: MAX_TAINTED_CONVERSATIONS }, (_, i) => `c${i}`);
  await fs.writeFile(file(home), JSON.stringify({ version: 1, ids }));
  await markConversationTainted("newest", home);
  const state = await loadTaintState(home);
  assert.equal(state.ids.size, MAX_TAINTED_CONVERSATIONS);
  assert.equal(state.ids.has("newest"), true);
  assert.equal(state.ids.has("c0"), false);
  assert.equal(state.ids.has("c1"), true);
  // Junk ids are ignored rather than stored.
  await markConversationTainted("", home);
  await markConversationTainted("x".repeat(500), home);
  assert.equal((await loadTaintState(home)).ids.size, MAX_TAINTED_CONVERSATIONS);
});

test("review 7: a corrupt taint file means every conversation with history is tainted, and it is not overwritten", async () => {
  for (const body of [
    "{broken",
    "[]",
    JSON.stringify({ version: 2, ids: [] }),
    JSON.stringify({ version: 1, ids: "all" }),
    JSON.stringify({ version: 1, ids: ["ok", 7] }),
    JSON.stringify({ version: 1, ids: [""] }),
  ]) {
    const home = await tmpHome();
    await fs.mkdir(wardenDir(home), { recursive: true });
    await fs.writeFile(file(home), body);
    assert.equal((await loadTaintState(home)).corrupt, true, body);
    assert.equal(await isConversationTainted("any", { home, hasHistory: true }), true, body);
    assert.equal(
      await isConversationTainted("brand-new", { home, hasHistory: false }),
      false,
      "a conversation with no turns has read nothing",
    );
    // Marking does not replace the file with a one-id list that would un-taint the rest.
    await markConversationTainted("c1", home);
    assert.equal(await fs.readFile(file(home), "utf8"), body);
    assert.equal(await isConversationTainted("other", { home, hasHistory: true }), true);
  }
});

test("review 13: the digest key is created once per home, 0600, and a damaged key is an error", async () => {
  const home = await tmpHome();
  const [a, b] = await Promise.all([loadDigestKey(home), loadDigestKey(home)]);
  assert.equal(a.length, 32);
  assert.deepEqual(a, b);
  const keyFile = path.join(wardenDir(home), "digest.key");
  assert.equal((await fs.stat(keyFile)).mode & 0o777, 0o600);
  assert.deepEqual(await loadDigestKey(home), a, "stable");
  const other = await tmpHome();
  assert.notDeepEqual(await loadDigestKey(other), a, "another home, another key");

  const damaged = await tmpHome();
  await fs.mkdir(wardenDir(damaged), { recursive: true });
  await fs.writeFile(path.join(wardenDir(damaged), "digest.key"), "short\n");
  await assert.rejects(loadDigestKey(damaged), /malformed/);
  // A failure is not cached: once the file is repaired the key loads.
  await fs.writeFile(path.join(wardenDir(damaged), "digest.key"), "ab".repeat(32) + "\n");
  assert.equal((await loadDigestKey(damaged)).length, 32);
});
