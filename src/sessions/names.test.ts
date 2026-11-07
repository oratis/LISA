import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-session-names-"));
process.env.LISA_HOME = temp;
const { saveSessionName, listSessionNames, InvalidSessionNameError } = await import("./names.js");
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
  for (const name of ["", "   ", "x".repeat(121), "line\nbreak", null]) {
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
