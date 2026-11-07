import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-session-names-"));
process.env.LISA_HOME = temp;
const {
  saveSessionName,
  listSessionNames,
  InvalidSessionNameError,
  SessionNameLimitError,
  MAX_SESSION_NAMES,
} = await import("./names.js");
const { homeScope } = await import("../paths.js");
after(() => fs.rm(temp, { recursive: true, force: true }));

test("names persist independently of transcripts and are isolated by agent and tenant", async () => {
  const file = path.join(temp, "sessions", "test-session.jsonl");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const transcript = '{"id":"test-session","type":"session"}\n';
  await fs.writeFile(file, transcript);
  await saveSessionName({ kind: "lisa", id: "test-session", name: "  我的计划  " });
  await saveSessionName({ kind: "agent/codex", id: "test-session", name: "Codex build" });
  await saveSessionName({ kind: "agent/claude-code", id: "test-session", name: "Claude review" });
  await saveSessionName({ kind: "lisa", id: "test-session", name: "更新计划" });
  const names = await listSessionNames();
  assert.equal(names.length, 3);
  assert.equal(names.find((n) => n.kind === "lisa")?.name, "更新计划");
  assert.equal(names.find((n) => n.kind === "agent/codex")?.name, "Codex build");
  assert.equal(await fs.readFile(file, "utf8"), transcript);
  await homeScope.run(path.join(temp, "another-user"), async () => {
    assert.deepEqual(await listSessionNames(), []);
    await saveSessionName({ kind: "agent/codex", id: "test-session", name: "Private name" });
    assert.equal((await listSessionNames())[0]?.name, "Private name");
  });
  assert.equal(
    (await listSessionNames()).find((n) => n.kind === "agent/codex")?.name,
    "Codex build",
  );
  for (const name of await fs.readdir(path.join(temp, "sessions", "names"))) {
    assert.equal((await fs.stat(path.join(temp, "sessions", "names", name))).mode & 0o777, 0o600);
  }
});

test("rejects invalid names, traversal and nonexistent Lisa sessions", async () => {
  for (const name of ["", "   ", "x".repeat(121), "line\nbreak", "evil\u202egnp.exe", null]) {
    await assert.rejects(
      saveSessionName({ kind: "lisa", id: "test-session", name }),
      InvalidSessionNameError,
    );
  }
  await assert.rejects(
    saveSessionName({ kind: "lisa", id: "../outside", name: "bad" }),
    InvalidSessionNameError,
  );
  await assert.rejects(
    saveSessionName({ kind: "../../outside", id: "x", name: "bad" }),
    InvalidSessionNameError,
  );
  await assert.rejects(saveSessionName({ kind: "lisa", id: "absent", name: "name" }), {
    code: "ENOENT",
  });
  assert.ok(!(await fs.readdir(temp)).includes("outside"));
});

test("concurrent renames reach disk in the order their updatedAt was issued", async () => {
  const saves = await Promise.all(
    ["first", "second", "third", "fourth"].map((name) =>
      saveSessionName({ kind: "agent/codex", id: "race-session", name }),
    ),
  );
  const stamps = saves.map((entry) => entry.updatedAt);
  assert.deepEqual(
    stamps,
    [...stamps].sort((a, b) => a - b),
  );
  assert.equal(new Set(stamps).size, stamps.length, "updatedAt is strictly increasing");
  const newest = saves.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
  const stored = (await listSessionNames()).find((n) => n.id === "race-session");
  assert.deepEqual(stored, newest);
});

test("the number of names per home is bounded, renaming an existing one still works", async () => {
  await homeScope.run(path.join(temp, "bounded-user"), async () => {
    const dir = path.join(temp, "bounded-user", "sessions", "names");
    await fs.mkdir(dir, { recursive: true });
    await saveSessionName({ kind: "agent/codex", id: "kept", name: "Kept" });
    const existing = (await fs.readdir(dir)).length;
    for (let i = existing; i < MAX_SESSION_NAMES; i++)
      await fs.writeFile(path.join(dir, i.toString(16).padStart(64, "0") + ".json"), "{}");
    await assert.rejects(
      saveSessionName({ kind: "agent/codex", id: "one-too-many", name: "Nope" }),
      SessionNameLimitError,
    );
    const renamed = await saveSessionName({ kind: "agent/codex", id: "kept", name: "Still ok" });
    assert.equal(renamed.name, "Still ok");
  });
});
