import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReadonlyConnector, type ConnectorResume } from "./service.js";
import { GoogleReadonlyDriver, type GoogleAccount, type GoogleResource } from "./google-driver.js";
import { GOOGLE_SCOPES } from "./google-oauth.js";
import { ConnectorError } from "./types.js";
import { MemorySecretStore } from "../warden/secrets.js";

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
test("Google refresh is serialized, persists before use, and revoked grants cannot commit", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-shared-connector-"));
  const secrets = new MemorySecretStore();
  let refreshes = 0,
    reads = 0,
    revoked = false,
    commits = 0;
  const driver = new GoogleReadonlyDriver("gmail", {
    client: async () => ({ clientId: "fixture.apps.googleusercontent.com" }),
    authorize: async (client, scopes) => ({
      ...client,
      accessToken: "expired",
      refreshToken: "refresh",
      expiry: 0,
      scopes: [...scopes],
      allowedScopes: [...scopes],
    }),
    http: async (url, _signal, init) => {
      if (url.endsWith("/token")) {
        refreshes++;
        return { access_token: "fresh", expires_in: 3600 };
      }
      if (url.includes("userinfo"))
        return { sub: "123", email: "fixture@example.com", email_verified: true };
      if (url.endsWith("/labels/INBOX")) return { id: "INBOX", name: "Inbox" };
      if (url.endsWith("/labels")) {
        assert.equal(init?.token, "fresh");
        reads++;
        return { labels: [{ id: "INBOX", name: "Inbox" }] };
      }
      if (url.includes("/messages?")) {
        if (revoked) throw new ConnectorError("google_reauthorization_required");
        return { messages: [] };
      }
      assert.fail(url);
    },
  });
  const service = new ReadonlyConnector({
    home,
    secrets,
    driver,
    changed: () => {},
    resume: async (run) => {
      await run.tools[0]!.execute(
        {
          operation: "messages",
          resourceId: "INBOX",
          timeMin: "2026-11-07T00:00:00Z",
          timeMax: "2026-11-08T00:00:00Z",
        },
        { cwd: home, signal: run.signal, log: () => {} },
      );
      await run.commit(async () => {
        commits++;
      });
    },
  });
  t.after(async () => {
    await service.stop();
    await fs.rm(home, { recursive: true, force: true });
  });
  await service.start();
  const r = await service.create("chat", "Read Gmail");
  await service.authorize(r.id, "login");
  const status = async () => (await service.list("chat"))[0]!.status;
  await until(async () => (await status()) === "selecting");
  await Promise.all([
    service.resources(r.id, 1, AbortSignal.timeout(5000)),
    service.resources(r.id, 1, AbortSignal.timeout(5000)),
  ]);
  assert.equal(refreshes, 1);
  assert.equal(reads, 2);
  const stored = await secrets.get((await secrets.list())[0]!.name);
  assert.equal(JSON.parse(stored!).accessToken, "fresh");
  revoked = true;
  await service.confirm(r.id, ["INBOX"], AbortSignal.timeout(5000));
  await until(async () => (await status()) === "failed");
  assert.equal((await service.list("chat"))[0]?.error, "google_reauthorization_required");
  assert.equal(commits, 0);
  assert.equal((await secrets.list()).length, 0);
});

test("Google restart retains the original task and delivers once with only its provider tool", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-google-restart-"));
  const secrets = new MemorySecretStore();
  let entered = false,
    deliveries = 0;
  const driver = new GoogleReadonlyDriver("google-calendar", {
    client: async () => ({ clientId: "fixture.apps.googleusercontent.com" }),
    authorize: async (client, scopes) => ({
      ...client,
      accessToken: "a",
      refreshToken: "r",
      expiry: Date.now() + 3600_000,
      scopes: [...scopes],
      allowedScopes: [...scopes],
    }),
    http: async () => ({ sub: "123", email: "fixture@example.com", email_verified: true }),
  });
  const options = { home, secrets, driver, changed: () => {} };
  const first = new ReadonlyConnector({
    ...options,
    resume: async (run) => {
      entered = true;
      await new Promise<void>((resolve) =>
        run.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      run.signal.throwIfAborted();
    },
  });
  const resume = async (run: ConnectorResume<GoogleAccount, GoogleResource>) => {
    assert.equal(run.request.prompt, "查看 Google Calendar 今天的忙闲");
    assert.deepEqual(
      run.tools.map((t) => t.name),
      ["google_calendar_read"],
    );
    await run.commit(async () => {
      deliveries++;
    });
  };
  const second = new ReadonlyConnector({ ...options, resume });
  const third = new ReadonlyConnector({ ...options, resume });
  t.after(async () => {
    await Promise.all([first.stop(), second.stop(), third.stop()]);
    await fs.rm(home, { recursive: true, force: true });
  });
  await first.start();
  const r = await first.create("chat", "查看 Google Calendar 今天的忙闲");
  await first.authorize(r.id, "freebusy");
  await until(async () => (await first.list("chat"))[0]?.status === "selecting");
  await first.confirm(r.id, ["fixture@example.com"], AbortSignal.timeout(5000));
  await until(async () => entered);
  await first.stop();
  await second.start();
  await until(async () => (await second.list("chat"))[0]?.status === "completed");
  await second.stop();
  await third.start();
  await third.stop();
  assert.equal(deliveries, 1);
  const raw = await fs.readFile(path.join(home, "connectors/google-calendar/state.json"), "utf8");
  assert.ok(!raw.includes("refreshToken"));
  assert.ok(!raw.includes(GOOGLE_SCOPES.freebusy[0]));
});
