import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

test("real Cloud server routes the console before tenant auth and enforces operator controls", async () => {
  const original = { ...process.env };
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-admin-server-"));
  Object.assign(process.env, {
    LISA_HOME: home,
    CLAUDE_HOME: path.join(home, "claude"),
    LISA_EDITION: "cloud",
    LISA_PUBLIC_ORIGIN: "https://cloud.meetlisa.ai",
    LISA_WEB_TOKEN: "console-server-test-master",
    LISA_CONSOLE_ENABLED: "1",
    LISA_ADMIN_EMAILS: "owner@example.com",
    LISA_SOUL_GIT: "0",
    LISA_MAIL_POLL_MINUTES: "0",
    LISA_FIRESTORE: "0",
  });
  delete process.env.LISA_REVIEWER_SEED;
  const { startWebServer } = await import("../web/server.js");
  const { ensureSeededAccount } = await import("../web/accounts.js");
  const { loadOrCreateSessionSecret, mintSession } = await import("../web/sessions-auth.js");
  const { consoleSecret } = await import("./http.js");
  const { mutateAdminState } = await import("./store.js");
  const acct = await ensureSeededAccount("owner@example.com", "server-test-password");
  const member = await ensureSeededAccount("member@example.com", "server-test-password");
  const sessionSecret = loadOrCreateSessionSecret();
  const server = await startWebServer({
    port: 0,
    host: "127.0.0.1",
    tools: [],
    model: "gemini-2.5-flash",
    thinking: false,
    reflect: false,
    idleMinutes: 0,
    hooks: [],
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(base + "/console")).status, 200);
    assert.equal((await fetch(base + "/console/app.js")).status, 200);
    assert.equal((await fetch(base + "/console/api/snapshot")).status, 401);
    const cookie = `lisa_console=${mintSession(acct.uid, consoleSecret(sessionSecret), { sv: acct.sessionVersion })}`;
    const report = await fetch(base + "/console/api/snapshot?days=7", { headers: { cookie } });
    assert.equal(report.status, 200);
    assert.equal(((await report.json()) as { summary: { users: number } }).summary.users, 2);
    const auth = {
      authorization: `Bearer ${mintSession(member.uid, sessionSecret, { sv: member.sessionVersion })}`,
    };
    assert.equal((await fetch(base + "/api/auth/me", { headers: auth })).status, 200);
    await mutateAdminState((s) => {
      s.settings.features.gateway = false;
      s.settings.features.chat = false;
    });
    assert.equal(
      (
        await fetch(base + "/chat", {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: '{"message":"test"}',
        })
      ).status,
      503,
    );
    assert.equal(
      (
        await fetch(base + "/gw/openai/v1/chat/completions", {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      503,
    );
    await mutateAdminState((s) => {
      s.users[member.uid] = { suspended: true, note: "test" };
    });
    assert.equal((await fetch(base + "/api/auth/me", { headers: auth })).status, 401);
    assert.equal((await fetch(base + "/console/api/me", { headers: { cookie } })).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    process.env = original;
    await fs.rm(home, { recursive: true, force: true });
  }
});
