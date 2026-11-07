import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-skills-cloud-"));
process.env.LISA_HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, "claude");
process.env.CODEX_HOME = path.join(home, "codex");
process.env.LISA_EDITION = "cloud";
process.env.LISA_PUBLIC_ORIGIN = "https://lisa.example";
process.env.LISA_WEB_TOKEN = "fixture-skills-cloud";
// The hosted gate refuses the shared token outright (see github-server.test);
// opt in so this test reaches the per-route guards a token caller would meet.
process.env.LISA_CLOUD_SHARED_TOKEN_OK = "1";
process.env.LISA_SOUL_GIT = "0";
process.env.LISA_MAIL_POLL_MINUTES = "0";
const { startWebServer } = await import("./server.js");
after(() => fs.rm(home, { recursive: true, force: true }));

test("cloud hides the host import catalog, refuses skill writes and token-only session names or expression writes", async () => {
  const external = path.join(home, "codex/skills/host-only");
  await fs.mkdir(external, { recursive: true });
  await fs.writeFile(
    path.join(external, "SKILL.md"),
    "---\nname: host-only\ndescription: Host fixture\n---\nPrivate host instructions.\n",
  );
  const server = await startWebServer({
    port: 0,
    host: "127.0.0.1",
    tools: [],
    model: "fixture",
    thinking: false,
    reflect: false,
    idleMinutes: 0,
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = {
    authorization: "Bearer fixture-skills-cloud",
    "content-type": "application/json",
  };
  try {
    const listed = await fetch(base + "/api/skills", { headers });
    assert.equal(listed.status, 200);
    const body = (await listed.json()) as { imports: unknown[]; canManage: boolean };
    assert.deepEqual(body.imports, []);
    assert.equal(body.canManage, false);
    for (const endpoint of ["/api/skills", "/api/skills/import"]) {
      const response = await fetch(base + endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "host-only",
          source: "codex",
          description: "Fixture",
          body: "Never write this",
        }),
      });
      assert.equal(response.status, 403);
      assert.match(await response.text(), /only available on this Mac/);
    }
    // A shared web token is not an account: it must not read or write
    // session names in the operator's own home.
    for (const method of ["GET", "POST"]) {
      const response = await fetch(base + "/api/session-names", {
        method,
        headers,
        body:
          method === "POST"
            ? JSON.stringify({ kind: "agent/codex", id: "x", name: "Operator" })
            : undefined,
      });
      assert.equal(response.status, 403);
      assert.match(await response.text(), /account_session_required/);
    }
    // Nor may it change the operator's conversation-expression preferences.
    const expressionWrite = await fetch(base + "/api/expressions/preferences", {
      method: "PUT",
      headers,
      body: JSON.stringify({ display: "off", frequency: "lively" }),
    });
    assert.equal(expressionWrite.status, 403);
    assert.deepEqual(await expressionWrite.json(), { error: "account_session_required" });
    assert.equal(
      await fs.stat(path.join(home, "expression-preferences.json")).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.equal(
      await fs.stat(path.join(home, "sessions/names")).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.equal(
      await fs.stat(path.join(home, "skills/host-only")).then(
        () => true,
        () => false,
      ),
      false,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
