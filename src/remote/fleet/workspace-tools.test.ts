import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { prepareWorkspaceTool } from "./workspace-tools.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-tools-"));
  const root = path.join(dir, "project");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "a.txt"), "before\n");
  return { dir, root, close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
test("workspace tools defer all disclosure/writes until a one-use decision", () => {
  const f = fixture();
  try {
    const read = prepareWorkspaceTool(f.root, "fleet_read", { file_path: "a.txt" });
    assert.doesNotMatch(JSON.stringify(read.input), /before/);
    assert.equal(read.execute(), "before\n");
    assert.throws(() => read.execute(), /tool_already_consumed/);
    const edit = prepareWorkspaceTool(f.root, "fleet_edit", {
      file_path: "a.txt",
      old_string: "before",
      new_string: "after",
    });
    assert.equal(fs.readFileSync(path.join(f.root, "a.txt"), "utf8"), "before\n");
    edit.execute();
    assert.equal(fs.readFileSync(path.join(f.root, "a.txt"), "utf8"), "after\n");
    const write = prepareWorkspaceTool(f.root, "fleet_write", {
      file_path: "new.txt",
      content: "created",
    });
    assert.equal(fs.existsSync(path.join(f.root, "new.txt")), false);
    write.execute();
    assert.equal(fs.readFileSync(path.join(f.root, "new.txt"), "utf8"), "created");
    const list = prepareWorkspaceTool(f.root, "fleet_list", { file_path: "." });
    assert.deepEqual(
      JSON.parse(list.execute()).map((e: { name: string }) => e.name),
      ["a.txt", "new.txt"],
    );
  } finally {
    f.close();
  }
});
test("workspace tools reject metadata, escapes, links, unknown arguments and oversized payloads", () => {
  const f = fixture();
  try {
    fs.symlinkSync(f.dir, path.join(f.root, "escape"));
    fs.linkSync(path.join(f.root, "a.txt"), path.join(f.root, "hard.txt"));
    fs.mkdirSync(path.join(f.root, ".git"));
    fs.writeFileSync(path.join(f.root, ".env"), "secret");
    for (const file_path of [
      "../private",
      ".git/config",
      ".env",
      "escape/anything",
      "hard.txt",
      "/etc/passwd",
      "a/../a.txt",
      "a\\b",
    ])
      assert.throws(() => prepareWorkspaceTool(f.root, "fleet_read", { file_path }));
    assert.throws(() => prepareWorkspaceTool(f.root, "shell", { file_path: "a.txt" }));
    assert.throws(() =>
      prepareWorkspaceTool(f.root, "fleet_read", { file_path: "a.txt", command: "anything" }),
    );
    assert.throws(() =>
      prepareWorkspaceTool(f.root, "fleet_write", {
        file_path: "new.txt",
        content: "x".repeat(40_000),
      }),
    );
    assert.deepEqual(
      JSON.parse(prepareWorkspaceTool(f.root, "fleet_list", { file_path: "." }).execute()),
      [],
    );
  } finally {
    f.close();
  }
});
test("changed bytes, inode, directory listing or workspace invalidate a pending decision", () => {
  const f = fixture();
  try {
    const call = () =>
      prepareWorkspaceTool(f.root, "fleet_write", { file_path: "a.txt", content: "overwrite" });
    let pending = call();
    fs.writeFileSync(path.join(f.root, "a.txt"), "new human data");
    assert.throws(() => pending.execute(), /workspace_changed/);
    pending = call();
    fs.unlinkSync(path.join(f.root, "a.txt"));
    fs.writeFileSync(path.join(f.root, "a.txt"), "new human data");
    assert.throws(() => pending.execute(), /workspace_changed/);
    pending = prepareWorkspaceTool(f.root, "fleet_list", { file_path: "." });
    fs.writeFileSync(path.join(f.root, "extra"), "x");
    assert.throws(() => pending.execute(), /workspace_changed/);
    pending = call();
    fs.renameSync(f.root, f.root + "-old");
    fs.mkdirSync(f.root);
    assert.throws(() => pending.execute(), /workspace_changed/);
  } finally {
    f.close();
  }
});
test("read/edit bound text size and reject ambiguous matches; a failed write cannot replay", () => {
  const f = fixture(),
    sync = fs.fsyncSync;
  try {
    fs.writeFileSync(path.join(f.root, "a.txt"), "same same");
    assert.throws(
      () =>
        prepareWorkspaceTool(f.root, "fleet_edit", {
          file_path: "a.txt",
          old_string: "same",
          new_string: "changed",
        }),
      /edit_match_required/,
    );
    const plan = prepareWorkspaceTool(f.root, "fleet_write", {
      file_path: "a.txt",
      content: "partial",
    });
    fs.fsyncSync = () => {
      throw new Error("disk failed");
    };
    assert.throws(() => plan.execute(), /disk failed/);
    fs.fsyncSync = sync;
    fs.writeFileSync(path.join(f.root, "a.txt"), "later human data");
    assert.throws(() => plan.execute(), /tool_already_consumed/);
    assert.equal(fs.readFileSync(path.join(f.root, "a.txt"), "utf8"), "later human data");
    fs.writeFileSync(path.join(f.root, "big.txt"), "x".repeat(65537));
    assert.throws(
      () => prepareWorkspaceTool(f.root, "fleet_read", { file_path: "big.txt" }),
      /text_file_limit/,
    );
    fs.writeFileSync(path.join(f.root, "binary"), Buffer.from([0, 1]));
    assert.throws(
      () => prepareWorkspaceTool(f.root, "fleet_read", { file_path: "binary" }),
      /text_file_limit/,
    );
  } finally {
    fs.fsyncSync = sync;
    f.close();
  }
});
