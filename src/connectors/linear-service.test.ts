import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReadonlyConnector, type ConnectorResume } from "./service.js";
import { LinearReadonlyDriver, type LinearAccount, type LinearResource } from "./linear-driver.js";
import { ConnectorError } from "./types.js";
import { MemorySecretStore } from "../warden/secrets.js";
const user = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Fixture",
  email: "fixture@example.com",
};
const team = {
  id: "00000000-0000-4000-8000-000000000002",
  name: "Selected team",
  access: "team" as const,
};
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function driver(
  options: { expired?: boolean; revoked?: () => boolean; refreshed?: () => void } = {},
) {
  return new LinearReadonlyDriver({
    authorize: async () => ({
      clientId: "fixture-client",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiry: options.expired ? 0 : Date.now() + 3600_000,
      scope: "read",
    }),
    fetch: () => async () => {
      options.refreshed?.();
      return new Response(
        JSON.stringify({
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          expires_in: 3600,
          scope: "read",
          token_type: "Bearer",
        }),
      );
    },
    connect: async (_e, _t, _f, _s, _r, work) =>
      work({
        call: async (name) => {
          if (name === "get_user") return user;
          if (name === "get_team") return team;
          if (name === "list_teams") return { teams: [team] };
          if (options.revoked?.()) throw new ConnectorError("linear_reauthorization_required");
          return { issues: [] };
        },
      }),
  });
}
test("Linear restart resumes the saved task once with only linear_read; state contains no credentials", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-linear-restart-"));
  const secrets = new MemorySecretStore();
  let entered = false,
    deliveries = 0;
  const options = { home, secrets, driver: driver(), changed: () => {} };
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
  const resume = async (run: ConnectorResume<LinearAccount, LinearResource>) => {
    assert.equal(run.request.prompt, "查看 Linear 团队工单");
    assert.equal(run.provider, "linear");
    assert.deepEqual(
      run.tools.map((t) => t.name),
      ["linear_read"],
    );
    await run.commit(async () => {
      deliveries++;
    });
  };
  const second = new ReadonlyConnector({ ...options, resume }),
    third = new ReadonlyConnector({ ...options, resume });
  t.after(async () => {
    await Promise.all([first.stop(), second.stop(), third.stop()]);
    await fs.rm(home, { recursive: true, force: true });
  });
  await first.start();
  const request = await first.create("chat", "查看 Linear 团队工单");
  await first.authorize(request.id, "login");
  await until(async () => (await first.list("chat"))[0]?.status === "selecting");
  await first.confirm(request.id, [team.id], AbortSignal.timeout(5000));
  await until(async () => entered);
  await first.stop();
  await second.start();
  await until(async () => (await second.list("chat"))[0]?.status === "completed");
  await second.stop();
  await third.start();
  await third.stop();
  assert.equal(deliveries, 1);
  const raw = await fs.readFile(path.join(home, "connectors/linear/state.json"), "utf8");
  assert.ok(!raw.includes("old-access"));
  assert.ok(!raw.includes("refreshToken"));
});
test("Linear serializes refresh and removes a revoked credential without committing a result", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-linear-refresh-")),
    secrets = new MemorySecretStore();
  let refreshes = 0,
    commits = 0,
    revoked = false;
  const service = new ReadonlyConnector({
    home,
    secrets,
    driver: driver({
      expired: true,
      revoked: () => revoked,
      refreshed: () => {
        refreshes++;
      },
    }),
    changed: () => {},
    resume: async (run) => {
      await run.tools[0]!.execute(
        { operation: "issues", resourceId: team.id },
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
  const r = await service.create("chat", "查看 Linear 工单");
  await service.authorize(r.id, "login");
  await until(async () => (await service.list("chat"))[0]?.status === "selecting");
  await Promise.all([
    service.resources(r.id, 1, AbortSignal.timeout(5000)),
    service.resources(r.id, 1, AbortSignal.timeout(5000)),
  ]);
  assert.equal(refreshes, 1);
  const saved = JSON.parse((await secrets.get((await secrets.list())[0]!.name))!);
  assert.equal(saved.refreshToken, "fresh-refresh");
  revoked = true;
  await service.confirm(r.id, [team.id], AbortSignal.timeout(5000));
  await until(async () => (await service.list("chat"))[0]?.status === "failed");
  assert.equal((await service.list("chat"))[0]?.error, "linear_reauthorization_required");
  assert.equal(commits, 0);
  assert.equal((await secrets.list()).length, 0);
});
