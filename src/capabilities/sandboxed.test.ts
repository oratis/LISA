import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSandboxedCapabilities } from "./sandboxed.js";
import { capsOf, defaultCapabilitiesFor, LOCAL_CAPABILITIES } from "./index.js";
import { writeTool } from "../tools/write.js";
import { editTool } from "../tools/edit.js";
import { applyPatchTool } from "../tools/apply_patch.js";
import { readTool } from "../tools/read.js";
import type { SandboxMode } from "../sandbox/mode.js";
import type { ToolContext } from "../types.js";

/**
 * H2 acceptance (docs/PLAN_HARNESS_ALIGNMENT_v1.0.md §3): the mutating fs tools
 * are bounded by the same mode as the shell. Before H2 `wrapForSandbox` had one
 * caller — the bash tool — so these three could write anywhere regardless.
 */

let root: string;
let outside: string;

before(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-sbx-"));
  root = path.join(base, "workspace");
  outside = path.join(base, "elsewhere");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
});
after(() => {
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});
beforeEach(() => {
  delete process.env.LISA_SANDBOX;
  delete process.env.LISA_SANDBOX_MODE;
});

/**
 * `allowTemp: false` because the fixture's "outside" directory necessarily
 * lives under os.tmpdir() on macOS, and temp is writable by default (see the
 * provider's note on Seatbelt parity). Turning it off isolates the workspace
 * boundary itself, which is what these cases are about; the default-on
 * behaviour gets its own test below.
 */
function ctxFor(mode: SandboxMode, allowTemp = false): ToolContext {
  return {
    cwd: root,
    signal: new AbortController().signal,
    log: () => {},
    caps: createSandboxedCapabilities({
      root,
      allowTemp,
      spec: { mode, allowNetwork: true, cwd: root },
    }),
  };
}

describe("workspace-write bounds the mutating fs tools", () => {
  test("writes inside the workspace succeed", async () => {
    const ctx = ctxFor("workspace-write");
    await writeTool.execute({ path: "inside.txt", content: "ok" }, ctx);
    assert.equal(fs.readFileSync(path.join(root, "inside.txt"), "utf8"), "ok");
  });

  test("write refuses a ../ escape", async () => {
    const ctx = ctxFor("workspace-write");
    await assert.rejects(
      writeTool.execute({ path: "../elsewhere/escaped.txt", content: "x" }, ctx),
      /confines writes to/,
    );
    assert.equal(fs.existsSync(path.join(outside, "escaped.txt")), false);
  });

  test("write refuses an absolute path outside the workspace", async () => {
    const ctx = ctxFor("workspace-write");
    await assert.rejects(
      writeTool.execute(
        { path: path.join(outside, "abs.txt"), content: "x" },
        ctx,
      ),
      /confines writes to/,
    );
    assert.equal(fs.existsSync(path.join(outside, "abs.txt")), false);
  });

  test("write refuses to follow a symlink out of the workspace", async () => {
    const link = path.join(root, "escape-link");
    if (!fs.existsSync(link)) fs.symlinkSync(outside, link);
    const ctx = ctxFor("workspace-write");
    await assert.rejects(
      writeTool.execute({ path: "escape-link/through.txt", content: "x" }, ctx),
      /confines writes to/,
      "a path check that ignores symlinks would have let this through",
    );
    assert.equal(fs.existsSync(path.join(outside, "through.txt")), false);
  });

  test("edit and apply_patch are bounded too, not just write", async () => {
    const target = path.join(outside, "victim.txt");
    fs.writeFileSync(target, "original");
    const ctx = ctxFor("workspace-write");

    await assert.rejects(
      editTool.execute(
        { path: target, old_string: "original", new_string: "tampered" },
        ctx,
      ),
      /confines writes to/,
    );
    await assert.rejects(
      applyPatchTool.execute(
        { patches: [{ path: target, action: "update", content: "tampered" }] },
        ctx,
      ),
      /confines writes to/,
    );
    await assert.rejects(
      applyPatchTool.execute(
        { patches: [{ path: target, action: "delete" }] },
        ctx,
      ),
      /confines writes to/,
    );
    assert.equal(fs.readFileSync(target, "utf8"), "original", "untouched");
  });

  test("reads outside the workspace still work — parity with Seatbelt's file-read*", async () => {
    const readable = path.join(outside, "readable.txt");
    fs.writeFileSync(readable, "visible");
    const ctx = ctxFor("workspace-write");
    const out = await readTool.execute({ path: readable }, ctx);
    assert.match(out, /visible/);
  });

  test("temp stays writable by default — bash can write there under the same mode", async () => {
    const ctx = ctxFor("workspace-write", true);
    const scratch = path.join(os.tmpdir(), `lisa-h2-scratch-${process.pid}.txt`);
    try {
      await writeTool.execute({ path: scratch, content: "scratch" }, ctx);
      assert.equal(fs.readFileSync(scratch, "utf8"), "scratch");
    } finally {
      fs.rmSync(scratch, { force: true });
    }
  });
});

describe("read-only forbids writes everywhere", () => {
  test("even inside the workspace", async () => {
    const ctx = ctxFor("read-only");
    await assert.rejects(
      writeTool.execute({ path: "nope.txt", content: "x" }, ctx),
      /forbids writes/,
    );
    assert.equal(fs.existsSync(path.join(root, "nope.txt")), false);
  });

  test("reads are unaffected", async () => {
    fs.writeFileSync(path.join(root, "readable.txt"), "hello");
    const ctx = ctxFor("read-only");
    assert.match(await readTool.execute({ path: "readable.txt" }, ctx), /hello/);
  });
});

describe("danger-full-access is the previous behaviour", () => {
  test("writes anywhere are allowed", async () => {
    const ctx = ctxFor("danger-full-access");
    const target = path.join(outside, "allowed.txt");
    await writeTool.execute({ path: target, content: "y" }, ctx);
    assert.equal(fs.readFileSync(target, "utf8"), "y");
  });
});

describe("the default world follows the resolved mode", () => {
  test("no env set → the plain local world, byte-for-byte the old default", () => {
    assert.equal(defaultCapabilitiesFor(root), LOCAL_CAPABILITIES);
  });

  test("LISA_SANDBOX=1 now bounds fs writes, not only bash", async () => {
    process.env.LISA_SANDBOX = "1";
    const ctx: ToolContext = {
      cwd: root,
      signal: new AbortController().signal,
      log: () => {},
    };
    assert.notEqual(capsOf(ctx), LOCAL_CAPABILITIES);
    // Under the filesystem root: outside both the workspace and any temp dir,
    // and unwritable anyway, so a regression here fails loudly instead of
    // scribbling on the host.
    await assert.rejects(
      writeTool.execute(
        { path: "/lisa-h2-must-not-exist/legacy.txt", content: "x" },
        ctx,
      ),
      /confines writes to/,
      "this is the hole H2 closes: before, LISA_SANDBOX=1 bounded bash but not write",
    );
  });

  test("an explicitly supplied world is never overridden by the environment", () => {
    process.env.LISA_SANDBOX_MODE = "read-only";
    const ctx = ctxFor("danger-full-access");
    assert.equal(capsOf(ctx), ctx.caps);
  });
});
