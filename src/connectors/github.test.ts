import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GitHubConnector, isGitHubReadRequest, type GitHubResume } from "./github.js";
import { GitHubError, type GitHubDriver } from "./github-driver.js";
import { MemorySecretStore } from "../warden/secrets.js";

const account = { id: 12, login: "octocat" };
const repo = { id: 42, fullName: "octocat/project", private: true };
const signal = () => AbortSignal.timeout(5000);
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 6000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function fixtureDriver(overrides: Partial<GitHubDriver> = {}): GitHubDriver {
  return {
    authorize: async () => ({ token: "fixture-secret", account }),
    account: async () => account,
    repositories: async () => [repo],
    repository: async (_token, name) => ({ ...repo, fullName: name }),
    read: async () => ({ commits: ["improve README"] }),
    ...overrides,
  };
}
async function fixture(
  t: { after: (fn: () => Promise<void>) => void },
  resume: (run: GitHubResume) => Promise<void> = async (run) => run.commit(async () => {}),
  driver = fixtureDriver(),
) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-gh-test-"));
  const secrets = new MemorySecretStore();
  const options = { home, driver, secrets, resume, changed: () => {} };
  const service = new GitHubConnector(options);
  await service.start();
  t.after(async () => {
    await service.stop();
    await fs.rm(home, { recursive: true, force: true });
  });
  const create = () => service.create("session_a", "只读查看 GitHub 最近提交");
  const status = async (id: string) =>
    (await service.list("session_a")).find((r) => r.id === id)!.status;
  const authorize = async (id: string) => {
    await service.authorize(id, "existing");
    await until(async () => (await status(id)) === "selecting");
  };
  return { home, options, secrets, service, create, authorize, status };
}

test("explicit read requests only; write requests and attachment instructions do not route", () => {
  assert.equal(isGitHubReadRequest("查看 GitHub 最近提交，汇总工作"), true);
  assert.equal(isGitHubReadRequest("create a GitHub PR and summarize it"), false);
  assert.equal(isGitHubReadRequest("总结附件"), false);
});

test("connect click → repository selection → one read-only continuation; duplicate confirms are harmless", async (t) => {
  let runs = 0;
  const f = await fixture(t, async (run) => {
    runs++;
    assert.equal(run.request.prompt, "只读查看 GitHub 最近提交");
    assert.deepEqual(
      run.tools.map((t) => t.name),
      ["github_read"],
    );
    const ctx = { cwd: "/tmp", signal: run.signal, log: () => {} };
    await assert.rejects(
      run.tools[0]!.execute({ operation: "commits", repository: "other/secret" }, ctx),
      /repository_not_granted/,
    );
    await assert.rejects(
      run.tools[0]!.execute({ operation: "merge", repository: repo.fullName }, ctx),
      /read_operation_required/,
    );
    assert.deepEqual(
      await run.tools[0]!.execute({ operation: "commits", repository: repo.fullName }, ctx),
      { commits: ["improve README"] },
    );
    await run.commit(async () => {});
  });
  const r = await f.create();
  assert.equal(r.status, "waiting");
  assert.equal((await f.secrets.list()).length, 0);
  await Promise.all([f.service.authorize(r.id, "existing"), f.service.authorize(r.id, "existing")]);
  await until(async () => (await f.status(r.id)) === "selecting");
  assert.equal(runs, 0);
  await Promise.all([
    f.service.confirm(r.id, [repo.fullName], signal()),
    f.service.confirm(r.id, [repo.fullName], signal()),
  ]);
  await until(async () => (await f.status(r.id)) === "completed");
  assert.equal(runs, 1);
  const persisted = await fs.readFile(path.join(f.home, "connectors/github/state.json"), "utf8");
  assert.ok(!persisted.includes("fixture-secret"));
  assert.ok(!JSON.stringify(await f.service.list("session_a")).includes("github/"));
  assert.equal(
    (await fs.stat(path.join(f.home, "connectors/github/state.json"))).mode & 0o777,
    0o600,
  );
});

test("late authorization after cancellation never installs a credential or resumes", async (t) => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let runs = 0;
  const f = await fixture(
    t,
    async () => {
      runs++;
    },
    fixtureDriver({
      authorize: async (_mode, _signal, code) => {
        code("ABCD-1234");
        await gate;
        return { token: "fixture-secret", account };
      },
    }),
  );
  const r = await f.create();
  await f.service.authorize(r.id, "login");
  await until(async () => (await f.service.list("session_a"))[0]?.userCode === "ABCD-1234");
  await f.service.cancel(r.id);
  finish();
  await f.service.stop();
  assert.equal(await f.status(r.id), "cancelled");
  assert.equal((await f.secrets.list()).length, 0);
  assert.equal(runs, 0);
});

test("cancel while reading prevents final delivery and disconnect deletes credentials", async (t) => {
  let entered = false,
    commits = 0;
  const f = await fixture(t, async (run) => {
    entered = true;
    await new Promise<void>((resolve) =>
      run.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    await run.commit(async () => {
      commits++;
    });
  });
  const r = await f.create();
  await f.authorize(r.id);
  await f.service.confirm(r.id, [repo.fullName], signal());
  await until(async () => entered);
  await f.service.disconnect();
  await f.service.stop();
  assert.equal(await f.status(r.id), "cancelled");
  assert.equal(commits, 0);
  assert.equal((await f.secrets.list()).length, 0);
});

test("a changed account fails validation before installing a grant", async (t) => {
  const f = await fixture(
    t,
    undefined,
    fixtureDriver({ account: async () => ({ id: 99, login: "someoneelse" }) }),
  );
  const r = await f.create();
  await f.authorize(r.id);
  await assert.rejects(
    f.service.confirm(r.id, [repo.fullName], signal()),
    /github_account_changed/,
  );
  assert.equal(await f.status(r.id), "selecting");
});

test("restart resumes interrupted read work; completed requests never run again", async (t) => {
  let started = false;
  const f = await fixture(t, async (run) => {
    started = true;
    await new Promise<void>((resolve) =>
      run.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    run.signal.throwIfAborted();
  });
  const r = await f.create();
  await f.authorize(r.id);
  await f.service.confirm(r.id, [repo.fullName], signal());
  await until(async () => started);
  await f.service.stop();
  let resumed = 0;
  const second = new GitHubConnector({
    ...f.options,
    resume: async (run) => {
      resumed++;
      await run.commit(async () => {});
    },
  });
  await second.start();
  t.after(() => second.stop());
  await until(async () => (await f.status(r.id)) === "completed");
  await second.stop();
  const third = new GitHubConnector({
    ...f.options,
    resume: async () => {
      resumed++;
    },
  });
  await third.start();
  await third.stop();
  assert.equal(resumed, 1);
});

test("corrupt/unknown schema fails closed without overwriting state", async (t) => {
  const f = await fixture(t);
  await f.service.stop();
  const file = path.join(f.home, "connectors/github/state.json");
  for (const raw of [
    "{broken",
    '{"version":2,"requests":[]}',
    '{"version":1,"requests":[{"id":"../escape"}]}',
  ]) {
    await fs.writeFile(file, raw);
    await assert.rejects(f.service.list("session_a"), /connector_state_corrupt/);
    assert.equal(await fs.readFile(file, "utf8"), raw);
  }
});

test("reauthorization stages a distinct credential until repository confirmation", async (t) => {
  let token = "first-token";
  const f = await fixture(
    t,
    async () => {
      throw new GitHubError("resume_empty_response");
    },
    fixtureDriver({ authorize: async () => ({ token, account }) }),
  );
  const r = await f.create();
  await f.authorize(r.id);
  await f.service.confirm(r.id, [repo.fullName], signal());
  await until(async () => (await f.status(r.id)) === "failed");
  const original = (await f.secrets.list())[0]!;
  token = "second-token";
  await f.authorize(r.id);
  assert.equal((await f.secrets.list()).length, 2);
  assert.equal(await f.secrets.get(original.name), "first-token");
  assert.equal((await f.service.list("session_a"))[0]!.connected, false);
  await f.service.cancel(r.id);
  assert.equal((await f.secrets.list()).length, 1);
  assert.equal(await f.secrets.get(original.name), "first-token");
});

test("two services sharing a home acquire only one effective resume lease", async (t) => {
  let entered = false,
    finish!: () => void,
    runs = 0;
  const f = await fixture(t, async (run) => {
    entered = true;
    runs++;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    await run.commit(async () => {});
  });
  const r = await f.create();
  await f.authorize(r.id);
  await f.service.confirm(r.id, [repo.fullName], signal());
  await until(async () => entered);
  const other = new GitHubConnector({
    ...f.options,
    resume: async (run) => {
      runs++;
      await run.commit(async () => {});
    },
  });
  await other.start();
  finish();
  await until(async () => (await f.status(r.id)) === "completed");
  await other.stop();
  assert.equal(runs, 1);
});

test("new user message cancels the pending original task", async (t) => {
  const f = await fixture(t);
  const r = await f.create();
  await f.authorize(r.id);
  await f.service.cancelSession("session_a");
  await assert.rejects(f.service.confirm(r.id, [repo.fullName], signal()), /request_not_selecting/);
  assert.equal(await f.status(r.id), "cancelled");
});

test("revoked token stops the grant and requires an explicit reconnect", async (t) => {
  const f = await fixture(
    t,
    async (run) => {
      await assert.rejects(
        run.tools[0]!.execute(
          { operation: "commits", repository: repo.fullName },
          { cwd: "/tmp", signal: run.signal, log: () => {} },
        ),
        /github_reauthorization_required/,
      );
      await run.commit(async () => assert.fail("must not publish a success"));
    },
    fixtureDriver({
      read: async () => {
        throw new GitHubError("github_reauthorization_required");
      },
    }),
  );
  const r = await f.create();
  await f.authorize(r.id);
  await f.service.confirm(r.id, [repo.fullName], signal());
  await until(async () => (await f.status(r.id)) === "failed");
  assert.equal((await f.service.list("session_a"))[0]!.connected, false);
  assert.equal((await f.secrets.list()).length, 0);
});
