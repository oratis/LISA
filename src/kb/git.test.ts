import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homeScope } from "../paths.js";
import { commitKb } from "./git.js";

const git = (cwd: string, args: string[]) =>
  execFileSync("git", ["-c", "user.name=KB test", "-c", "user.email=kb@test", ...args], {
    cwd,
    encoding: "utf8",
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  }).trim();

async function outerRepository(run: (root: string, head: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-kb-git-"));
  const disabled = process.env.LISA_KB_NO_GIT;
  delete process.env.LISA_KB_NO_GIT;
  try {
    git(root, ["init", "-q"]);
    fs.writeFileSync(path.join(root, "unrelated.txt"), "original");
    git(root, ["add", "unrelated.txt"]);
    git(root, ["commit", "-qm", "outer baseline"]);
    const head = git(root, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(root, "unrelated.txt"), "staged user edit");
    git(root, ["add", "unrelated.txt"]);
    await run(root, head);
    assert.equal(
      git(root, ["rev-parse", "HEAD"]),
      head,
      "KB must not commit the enclosing project",
    );
    assert.equal(git(root, ["diff", "--cached", "--name-only"]), "unrelated.txt");
  } finally {
    if (disabled === undefined) delete process.env.LISA_KB_NO_GIT;
    else process.env.LISA_KB_NO_GIT = disabled;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function write(root: string, name: string, text: string) {
  const home = path.join(root, name),
    kb = path.join(home, "kb");
  fs.mkdirSync(kb, { recursive: true });
  fs.writeFileSync(path.join(kb, "note.md"), text);
  await homeScope.run(home, () => commitKb("kb: " + name));
  return kb;
}

test("KB commits isolate sequential and concurrent homes from their enclosing repository", async () => {
  await outerRepository(async (root) => {
    const first = await write(root, "first", "first note");
    const second = await write(root, "second", "second note");
    const others = await Promise.all([
      write(root, "third", "third note"),
      write(root, "fourth", "fourth note"),
    ]);
    for (const kb of [first, second, ...others]) {
      assert.equal(git(kb, ["rev-parse", "--show-toplevel"]), fs.realpathSync(kb));
      assert.equal(git(kb, ["ls-files"]), "note.md");
    }
  });
});

test("KB commits ignore inherited Git repository and index overrides", async () => {
  await outerRepository(async (root) => {
    const overrides = {
      GIT_DIR: path.join(root, ".git"),
      GIT_WORK_TREE: root,
      GIT_INDEX_FILE: path.join(root, ".git", "index"),
    };
    const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
    try {
      Object.assign(process.env, overrides);
      const kb = await write(root, "override", "private note");
      assert.equal(git(kb, ["ls-files"]), "note.md");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

test("KB refuses a redirected Git directory and retries after it becomes safe", async () => {
  await outerRepository(async (root) => {
    const kb = path.join(root, "redirect", "kb");
    fs.mkdirSync(kb, { recursive: true });
    fs.symlinkSync(path.join(root, ".git"), path.join(kb, ".git"), "dir");
    await write(root, "redirect", "private note");
    assert.equal(git(root, ["diff", "--cached", "--name-only"]), "unrelated.txt");
    fs.unlinkSync(path.join(kb, ".git"));
    await write(root, "redirect", "retried note");
    assert.equal(git(kb, ["show", "HEAD:note.md"]), "retried note");
  });
});
