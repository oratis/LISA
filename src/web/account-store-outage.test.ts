/**
 * An unreadable account store is an outage, not a sign-out: the gate answers 503
 * so clients retry. A 401 here made the relay refuse the Mac with 403, and the Mac
 * then turned phone connections off for good (#481).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-account-outage-"));
process.env.LISA_HOME = dir;
process.env.CLAUDE_HOME = path.join(dir, "claude");
process.env.LISA_EDITION = "cloud";
process.env.LISA_PUBLIC_ORIGIN = "https://cloud.example.com";
process.env.LISA_WEB_TOKEN = "test-only-operator-token";
process.env.LISA_SOUL_GIT = "0";
process.env.LISA_MAIL_POLL_MINUTES = "0";
for (const name of [
  "LISA_REVIEWER_SEED",
  "LISA_FIRESTORE_PROJECT",
  "GOOGLE_CLOUD_PROJECT",
  "LISA_MANAGED_SESSION",
  "LISA_MODEL_FALLBACK",
  "LISA_BASE_URL",
  "LISA_PROVIDER",
])
  delete process.env[name];

const { startWebServer } = await import("./server.js");
const { createEmailAccount, sessionAccountState } = await import("./accounts.js");
const { mintSession, loadOrCreateSessionSecret } = await import("./sessions-auth.js");
let server: Awaited<ReturnType<typeof startWebServer>>;
let base: string;
const originalFetch = globalThis.fetch;

before(async () => {
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith("http://127.0.0.1:"))
      throw new Error("unexpected external request");
    return originalFetch(url, init);
  };
  server = await startWebServer({
    port: 0,
    host: "127.0.0.1",
    tools: [],
    model: "gemini-2.5-flash",
    thinking: false,
    reflect: false,
    idleMinutes: 0,
    hooks: [],
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  globalThis.fetch = originalFetch;
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an unreadable account store answers 503, a revoked session 401", async () => {
  const user = await createEmailAccount("outage@example.com", "test-password");
  const token = mintSession(user.uid, loadOrCreateSessionSecret());
  const me = () => fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await me()).status, 200);
  assert.equal(await sessionAccountState(user.uid, user.sessionVersion), "valid");
  assert.equal(await sessionAccountState(user.uid, user.sessionVersion + 1), "revoked");

  const file = path.join(dir, "accounts.json");
  const good = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, "{broken");
  const spy = console.error;
  console.error = () => {};
  try {
    assert.equal(await sessionAccountState(user.uid, user.sessionVersion), "unavailable");
    const outage = await me();
    assert.equal(outage.status, 503);
    assert.equal(outage.headers.get("retry-after"), "5");
    assert.deepEqual(await outage.json(), { error: "account_service_unavailable" });
  } finally {
    console.error = spy;
    fs.writeFileSync(file, good);
  }
  assert.equal((await me()).status, 200, "the same session works again once the store does");

  const forged = mintSession(user.uid, loadOrCreateSessionSecret(), {
    sv: user.sessionVersion + 1,
  });
  const revoked = await fetch(`${base}/api/auth/me`, {
    headers: { authorization: `Bearer ${forged}` },
  });
  assert.equal(revoked.status, 401);
});
