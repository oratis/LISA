import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReadonlyConnector, type ConnectorResume } from "./service.js";
import { GoogleReadonlyDriver, type GoogleAccount, type GoogleResource } from "./google-driver.js";
import { GOOGLE_SCOPES } from "./google-oauth.js";
import { ConnectorError } from "./types.js";
import { GameImportDriver } from "./gaming/import.js";
import type { Resource } from "./workspace/data.js";
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

test("batch confirmation requires the exact ordered set of selected resources before saving a grant", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-connector-batch-"));
  const resource = (id: string) => ({ id, name: id });
  let returned = ["1", "3"];
  const selections: string[][] = [];
  const driver = {
    id: "batch",
    authModes: ["login"],
    reauthorizationCode: "reauthorize",
    validAccount: (value: unknown): value is string => typeof value === "string",
    accountId: (value: string) => value,
    validResource: (value: unknown): value is ReturnType<typeof resource> =>
      !!value && typeof (value as { id?: unknown }).id === "string",
    validResourceName: (value: unknown): value is string => typeof value === "string",
    authorize: async () => ({ account: "account", token: "test" }),
    account: async () => "account",
    resources: async () => [],
    resource: async () => assert.fail("batch provider should use one filtered request"),
    resolveResources: async (_credentials: unknown, ids: string[]) => {
      selections.push([...ids]);
      return returned.map(resource);
    },
    tool: {
      name: "games",
      description: "Read games",
      inputSchema: { type: "object" as const, properties: {} },
    },
    read: async () => ({}),
  };
  const service = new ReadonlyConnector({
    home,
    driver,
    secrets: new MemorySecretStore(),
    changed: () => {},
    resume: async (run) => run.commit(async () => {}),
  });
  t.after(async () => {
    await service.stop();
    await fs.rm(home, { recursive: true, force: true });
  });
  await service.start();
  const r = await service.create("chat", "Read games");
  await service.authorize(r.id, "login");
  await until(async () => (await service.list("chat"))[0]?.status === "selecting");
  for (const items of [["1", "3"], ["1"], ["1", "2", "3"], ["2", "1"], ["1", "1"]]) {
    returned = items;
    await assert.rejects(
      service.confirm(r.id, ["1", "1", "2"], AbortSignal.timeout(1000)),
      /connector_invalid_response/,
    );
    assert.equal((await service.summary()).resourceCount, 0);
  }
  returned = ["1", "2"];
  await service.confirm(r.id, ["1", "1", "2"], AbortSignal.timeout(1000));
  assert.equal((await service.summary()).resourceCount, 2);
  assert.deepEqual(
    selections,
    Array.from({ length: 6 }, () => ["1", "2"]),
  );
});

function hold() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function stageGame(
  service: ReadonlyConnector<Resource, Resource>,
  session: string,
  force = false,
) {
  const request = await service.create(session, "Import my game", force);
  assert.equal(request.status, "waiting");
  await service.authorize(request.id, "import", JSON.stringify([{ title: "Game" }]));
  await until(async () =>
    (await service.list(session)).some((r) => r.id === request.id && r.status === "selecting"),
  );
  const [game] = await service.resources(request.id, 1, AbortSignal.timeout(2000));
  return { request, ids: [game!.id] };
}

test("game grants bind the displayed model at confirmation, on reuse and each durable disclosure", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-recipient-"));
  const secrets = new MemorySecretStore();
  let recipient = "Model A";
  let changeDuringResolution = false;
  class SwitchingDriver extends GameImportDriver {
    override async resource(...args: Parameters<GameImportDriver["resource"]>) {
      const result = await super.resource(...args);
      if (changeDuringResolution) recipient = "Model B";
      return result;
    }
  }
  const driver = new SwitchingDriver();
  const active = hold(),
    resume = hold();
  let result: Promise<unknown> | undefined;
  let committed = false;
  const service = new ReadonlyConnector({
    home,
    driver,
    secrets,
    changed: () => {},
    recipient: () => recipient,
    resume: async (run) => {
      assert.equal(run.recipient, "Model A");
      active.release();
      await resume.promise;
      result = (async () => {
        await assert.rejects(
          run.tools[0]!.execute(
            { operation: "list" },
            { cwd: home, signal: run.signal, log: () => {} },
          ),
          /connector_recipient_changed/,
        );
        await assert.rejects(
          run.persistTrace!(async () => {
            committed = true;
          }),
          /connector_recipient_changed/,
        );
        await assert.rejects(
          run.commit(async () => {
            committed = true;
          }),
          /connector_recipient_changed/,
        );
      })();
      await result;
      throw new ConnectorError("connector_recipient_changed");
    },
  });
  t.after(async () => {
    resume.release();
    await service.stop();
    await fs.rm(home, { recursive: true, force: true });
  });
  await service.start();
  const { request, ids } = await stageGame(service, "chat");
  for (const expected of [undefined, "", "Model B"])
    await assert.rejects(
      service.confirm(request.id, ids, AbortSignal.timeout(2000), expected),
      /connector_recipient_changed/,
    );
  changeDuringResolution = true;
  await assert.rejects(
    service.confirm(request.id, ids, AbortSignal.timeout(2000), "Model A"),
    /connector_recipient_changed/,
  );
  assert.equal((await service.summary()).resourceCount, 0);
  changeDuringResolution = false;
  recipient = "Model A";
  await service.confirm(request.id, ids, AbortSignal.timeout(2000), recipient);
  await active.promise;
  recipient = "Model B";
  resume.release();
  await until(async () => !!result);
  await result;
  assert.equal(committed, false);
  await until(async () => (await service.list("chat"))[0]?.status === "failed");
  await assert.rejects(service.retry(request.id), /connector_recipient_changed/);
  assert.equal((await service.create("chat2", "Read previous snapshot")).status, "waiting");
  recipient = "Model A";
  const replacement = await service.create("chat3", "Import a new game", true);
  assert.equal(replacement.status, "waiting");
  await service.authorize(replacement.id, "import", "[]");
  await until(async () => (await service.list("chat3"))[0]?.status === "failed");
  await assert.rejects(service.retry(replacement.id), /request_cannot_retry/);
  const reused = await service.create("chat4", "Read my already selected games");
  assert.equal(reused.status, "ready");
  await service.cancel(reused.id);
});

test("game grants created before recipient binding require fresh selection on restart", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-recipient-migrate-"));
  const options = {
    home,
    secrets: new MemorySecretStore(),
    driver: new GameImportDriver(),
    changed: () => {},
    resume: async (run: ConnectorResume<Resource, Resource>) => run.commit(async () => {}),
  };
  const old = new ReadonlyConnector(options);
  const current = new ReadonlyConnector({ ...options, recipient: () => "Model A" });
  t.after(async () => {
    await old.stop();
    await current.stop();
    await fs.rm(home, { recursive: true, force: true });
  });
  await old.start();
  const { request, ids } = await stageGame(old, "chat");
  await old.confirm(request.id, ids, AbortSignal.timeout(2000));
  await until(async () => (await old.list("chat"))[0]?.status === "completed");
  await old.stop();
  await current.start();
  const fresh = await current.create("new-chat", "Read again");
  assert.equal(fresh.status, "waiting");
  assert.equal(fresh.connected, false);
  assert.deepEqual(fresh.resources, []);
});

test("a disconnect in another service instance blocks a pending game read, its trace and its commit", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-revoke-read-"));
  const entered = hold(),
    finish = hold(),
    checked = hold();
  class SlowDriver extends GameImportDriver {
    override async read(...args: Parameters<GameImportDriver["read"]>) {
      const result = await super.read(...args);
      entered.release();
      await finish.promise;
      return result;
    }
  }
  let traces = 0,
    commits = 0,
    actualError: unknown;
  const options = {
    home,
    driver: new SlowDriver(),
    secrets: new MemorySecretStore(),
    recipient: () => "Model A",
    changed: () => {},
    resume: async (run: ConnectorResume<Resource, Resource>) => {
      try {
        await assert.rejects(
          run.tools[0]!.execute(
            { operation: "list" },
            { cwd: home, signal: run.signal, log: () => {} },
          ),
          /connection_not_granted/,
        );
        await assert.rejects(
          run.persistTrace!(async () => {
            traces++;
          }),
          /connection_not_granted/,
        );
        await assert.rejects(
          run.commit(async () => {
            commits++;
          }),
          /request_cancelled/,
        );
      } catch (e) {
        actualError = e;
      } finally {
        checked.release();
      }
    },
  };
  const first = new ReadonlyConnector(options),
    second = new ReadonlyConnector(options);
  t.after(async () => {
    finish.release();
    await first.stop();
    await second.stop();
    await fs.rm(home, { recursive: true, force: true });
  });
  await first.start();
  const { request, ids } = await stageGame(first, "chat");
  await first.confirm(request.id, ids, AbortSignal.timeout(2000), "Model A");
  await entered.promise;
  await second.disconnect();
  finish.release();
  await checked.promise;
  if (actualError) throw actualError;
  assert.equal(traces, 0);
  assert.equal(commits, 0);
  assert.equal((await first.list("chat"))[0]?.status, "cancelled");
});
