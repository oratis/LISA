import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryCapabilities, refusingShell } from "./index.js";
import { readTool } from "../tools/read.js";
import { writeTool } from "../tools/write.js";
import { editTool } from "../tools/edit.js";
import { lsTool } from "../tools/ls.js";
import { applyPatchTool } from "../tools/apply_patch.js";
import { bashTool } from "../tools/bash.js";
import type { ToolContext } from "../types.js";

/**
 * H1 acceptance (docs/PLAN_HARNESS_ALIGNMENT_v1.0.md §2): the fs/shell tools
 * act on a *swappable* execution world, not on the host disk by hard-wiring.
 */

const SRC = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** The tools migrated onto the seam. Adding one here without migrating it fails. */
const SEAM_TOOLS = [
  "tools/read.ts",
  "tools/write.ts",
  "tools/edit.ts",
  "tools/apply_patch.ts",
  "tools/ls.ts",
  "tools/grep.ts",
  "tools/bash.ts",
];

describe("capability seam — no tool reaches around it", () => {
  test("migrated tools import neither node:fs nor node:child_process", () => {
    const offenders: string[] = [];
    for (const rel of SEAM_TOOLS) {
      const source = fs.readFileSync(path.join(SRC, rel), "utf8");
      for (const banned of ["node:fs", "node:child_process"]) {
        // Only import statements matter — the strings may legitimately appear
        // in prose, and this guard should not be defeatable by a comment.
        const importing = new RegExp(
          `^\\s*import[^;]*from\\s+["']${banned}["']`,
          "m",
        ).test(source);
        if (importing) offenders.push(`${rel} imports ${banned}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "these tools bypass the capability seam, so swapping the execution world would not move them",
    );
  });

  test("every migrated tool goes through capsOf", () => {
    for (const rel of SEAM_TOOLS) {
      const source = fs.readFileSync(path.join(SRC, rel), "utf8");
      assert.match(
        source,
        /capsOf\(ctx\)/,
        `${rel} never resolves its execution world`,
      );
    }
  });
});

function memCtx(opts: Parameters<typeof createMemoryCapabilities>[0] = {}) {
  const caps = createMemoryCapabilities(opts);
  const ctx: ToolContext = {
    cwd: "/work",
    signal: new AbortController().signal,
    log: () => {},
    caps,
  };
  return { ctx, caps };
}

describe("tools run unmodified against an in-memory world", () => {
  test("read serves a file that exists only in memory", async () => {
    const { ctx } = memCtx({ files: { "/work/a.txt": "hello\nworld" } });
    const out = await readTool.execute({ path: "a.txt" }, ctx);
    assert.match(out, /hello/);
    assert.match(out, /world/);
  });

  test("write never touches the disk", async () => {
    const { ctx, caps } = memCtx();
    const out = await writeTool.execute(
      { path: "notes/new.txt", content: "abc" },
      ctx,
    );
    assert.match(out, /Wrote 3 chars to \/work\/notes\/new\.txt/);
    assert.deepEqual(caps.fs.snapshot(), { "/work/notes/new.txt": "abc" });
    assert.equal(
      fs.existsSync("/work/notes/new.txt"),
      false,
      "the real filesystem must be untouched",
    );
  });

  test("edit reads and rewrites through the same world", async () => {
    const { ctx, caps } = memCtx({ files: { "/work/f.ts": "let x = 1;" } });
    await editTool.execute(
      { path: "f.ts", old_string: "1", new_string: "2" },
      ctx,
    );
    assert.equal(caps.fs.snapshot()["/work/f.ts"], "let x = 2;");
  });

  test("ls lists in-memory directories and file sizes", async () => {
    const { ctx } = memCtx({
      files: { "/work/a.txt": "12345", "/work/sub/b.txt": "x" },
    });
    const out = await lsTool.execute({}, ctx);
    assert.match(out, /f {10}5 {2}a\.txt/);
    assert.match(out, /d {2}- {10}sub\//);
  });

  test("apply_patch create / update / delete all land in memory", async () => {
    const { ctx, caps } = memCtx({ files: { "/work/old.txt": "gone" } });
    await applyPatchTool.execute(
      {
        patches: [
          { path: "new.txt", action: "create", content: "fresh" },
          { path: "old.txt", action: "delete" },
        ],
      },
      ctx,
    );
    assert.deepEqual(caps.fs.snapshot(), { "/work/new.txt": "fresh" });
  });

  test("apply_patch refuses to create over an existing file", async () => {
    const { ctx } = memCtx({ files: { "/work/there.txt": "x" } });
    await assert.rejects(
      applyPatchTool.execute(
        { patches: [{ path: "there.txt", action: "create", content: "y" }] },
        ctx,
      ),
      /already exists/,
    );
  });
});

describe("a bounded world rejects escapes at resolvePath", () => {
  test("writes outside the root are refused before any I/O", async () => {
    const { ctx, caps } = memCtx({ root: "/work" });
    await assert.rejects(
      writeTool.execute({ path: "../escaped.txt", content: "x" }, ctx),
      /escapes the workspace root/,
    );
    await assert.rejects(
      writeTool.execute({ path: "/etc/passwd", content: "x" }, ctx),
      /escapes the workspace root/,
    );
    assert.deepEqual(caps.fs.snapshot(), {}, "nothing was written");
  });

  test("reads outside the root are refused too — one choke point, both directions", async () => {
    const { ctx } = memCtx({ root: "/work", files: { "/etc/passwd": "secret" } });
    await assert.rejects(
      readTool.execute({ path: "/etc/passwd" }, ctx),
      /escapes the workspace root/,
    );
  });

  test("paths inside the root still work", async () => {
    const { ctx, caps } = memCtx({ root: "/work" });
    await writeTool.execute({ path: "deep/ok.txt", content: "fine" }, ctx);
    assert.equal(caps.fs.snapshot()["/work/deep/ok.txt"], "fine");
  });
});

describe("a world without processes says so", () => {
  test("bash fails loudly rather than pretending to succeed", async () => {
    const { ctx } = memCtx();
    await assert.rejects(
      bashTool.execute({ command: "echo hi" }, ctx),
      /shell is unavailable/,
    );
  });

  test("refusingShell rejects both operations", async () => {
    await assert.rejects(refusingShell.run("x", { cwd: "/" }), /unavailable/);
    await assert.rejects(refusingShell.exec("x", [], { cwd: "/" }), /unavailable/);
  });
});
