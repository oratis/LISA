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
    assert.ok(s && s.type !== "http");
    assert.deepEqual(s.args, ["mcp-server-git"]);
    assert.deepEqual(s.env, { TOKEN: "x" });
    assert.equal(s.enabled, false);
    assert.equal(s.alwaysLoad, true);
  });

  test("save upserts by name", async () => {
    await mod.saveMcpServer("a", { command: "one" });
    await mod.saveMcpServer("a", { command: "two" });
    const all = await mod.loadMcpConfig();
    assert.equal(all.length, 1);
    assert.ok(all[0] && all[0].type !== "http");
    assert.equal(all[0].command, "two");
  });

  test("concurrent config updates keep stdio and HTTP entries and restrict file permissions", async () => {
    await Promise.all([
      mod.saveMcpServer("stdio", { command: "x" }),
      mod.saveMcpServer("docs", {
        type: "http",
        url: "https://example.org/mcp",
        allowedTools: ["search"],
      }),
    ]);
    const entries = await mod.loadMcpConfig();
    assert.equal(entries.length, 2);
    const http = entries.find((spec) => spec.type === "http");
    assert.ok(http && http.type === "http");
    assert.deepEqual(http.allowedTools, ["search"]);
    assert.equal(fs.statSync(mod.MCP_CONFIG_PATH).mode & 0o777, 0o600);
  });

  test("an invalid remote entry never runs as stdio or disables other servers", async () => {
    fs.writeFileSync(
      mod.MCP_CONFIG_PATH,
      JSON.stringify({
        mcpServers: {
          mixed: { command: "sh", url: "https://example.org/mcp" },
          private: { type: "http", url: "https://127.0.0.1/mcp" },
          plain: { url: "http://example.org/mcp" },
          credential: { url: "https://user:secret@example.org/mcp" },
          token: { url: "https://example.org/mcp?token=secret" },
          headers: { url: "https://example.org/mcp", headers: { Authorization: "secret" } },
          valid: { command: "x" },
          docs: { url: "https://example.org/mcp" },
        },
      }),
    );
    const warnings: string[] = [];
    assert.deepEqual(
      (await mod.loadMcpConfig((s) => warnings.push(s))).map((s) => s.name),
      ["valid", "docs"],
    );
    assert.equal(warnings.length, 6);
    assert.doesNotMatch(warnings.join(" "), /secret/);
  });

  test("delete removes a server and reports presence", async () => {
    await mod.saveMcpServer("a", { command: "x" });
    await mod.saveMcpServer("b", { command: "y" });
    assert.equal(await mod.deleteMcpServer("a"), true);
    assert.deepEqual(
      (await mod.loadMcpConfig()).map((s) => s.name),
      ["b"],
    );
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
    assert.deepEqual(
      all.map((s) => s.name),
      ["fresh"],
    );
  });
});
