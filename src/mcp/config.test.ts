import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// CONFIG_PATH (mcp.json) is derived from lisaHome() at import; set a tmp home
// before importing (dynamic import). Per-file process isolation keeps it local.
let mod: typeof import("./config.js");
let home: string;

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-mcp-"));
  process.env.LISA_HOME = home;
  mod = await import("./config.js");
});
after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  // Each test starts from a clean mcp.json.
  fs.rmSync(path.join(home, "mcp.json"), { force: true });
});

describe("mcp config — load/save/delete", () => {
  test("no file → empty list", async () => {
    assert.deepEqual(await mod.loadMcpConfig(), []);
  });

  test("save then load applies defaults for omitted fields", async () => {
    await mod.saveMcpServer("fs", { command: "npx" });
    const all = await mod.loadMcpConfig();
    assert.equal(all.length, 1);
    assert.deepEqual(all[0], {
      name: "fs",
      command: "npx",
      args: [],
      env: undefined,
      enabled: true,
      alwaysLoad: false,
    });
  });

  test("explicit fields round-trip", async () => {
    await mod.saveMcpServer("git", {
      command: "uvx",
      args: ["mcp-server-git"],
      env: { TOKEN: "x" },
      enabled: false,
      alwaysLoad: true,
    });
    const [s] = await mod.loadMcpConfig();
    assert.deepEqual(s!.args, ["mcp-server-git"]);
    assert.deepEqual(s!.env, { TOKEN: "x" });
    assert.equal(s!.enabled, false);
    assert.equal(s!.alwaysLoad, true);
  });

  test("save upserts by name", async () => {
    await mod.saveMcpServer("a", { command: "one" });
    await mod.saveMcpServer("a", { command: "two" });
    const all = await mod.loadMcpConfig();
    assert.equal(all.length, 1);
    assert.equal(all[0]!.command, "two");
  });

  test("delete removes a server and reports presence", async () => {
    await mod.saveMcpServer("a", { command: "x" });
    await mod.saveMcpServer("b", { command: "y" });
    assert.equal(await mod.deleteMcpServer("a"), true);
    assert.deepEqual((await mod.loadMcpConfig()).map((s) => s.name), ["b"]);
    assert.equal(await mod.deleteMcpServer("a"), false, "second delete reports not-present");
  });

  test("delete on a missing file → false", async () => {
    assert.equal(await mod.deleteMcpServer("anything"), false);
  });

  test("loadMcpConfig throws on corrupt JSON", async () => {
    fs.writeFileSync(path.join(home, "mcp.json"), "{ not json");
    await assert.rejects(mod.loadMcpConfig(), /failed to parse/);
  });

  test("saveMcpServer recovers from a corrupt file (starts fresh, keeps the add)", async () => {
    fs.writeFileSync(path.join(home, "mcp.json"), "{ corrupt");
    await mod.saveMcpServer("fresh", { command: "ok" });
    const all = await mod.loadMcpConfig();
    assert.deepEqual(all.map((s) => s.name), ["fresh"]);
  });
});
