import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { connectMcpServers } from "../../../mcp/client.js";

let home: string;
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.LISA_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-social-mcp-"));
  process.env.LISA_HOME = home;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

test("bundled connector server completes an MCP stdio handshake", async () => {
  const connected = await connectMcpServers([{
    name: "bluesky",
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      path.resolve("src/cli.ts"),
      "sense",
      "social",
      "serve-connector",
      "bluesky",
    ],
  }]);
  try {
    assert.equal(connected.length, 1);
    assert.deepEqual(
      connected[0]!.tools.map((tool) => tool.name).sort(),
      [
        "mcp__bluesky__social_account_disconnect",
        "mcp__bluesky__social_accounts_list",
        "mcp__bluesky__social_capabilities",
        "mcp__bluesky__social_draft_validate",
        "mcp__bluesky__social_publish",
      ],
    );
  } finally {
    await Promise.all(connected.map((item) => item.close()));
  }
});
